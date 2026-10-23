// The attempt ledger: how many recent attempts of a request failed, and why.
//
// A request is known by a fingerprint of its model, messages and tools, so an
// identical body sent again is the same request again. When a
// /v1/chat/completions response has ended, index.ts settles the attempt here
// (settleAttempt): a failure is counted, a success clears the record, and a
// client that hung up, an HTTP 4xx answer or a refusal changes nothing.
//
// The count bounds the retries of one request. Clients on the AI SDK
// (AiderDesk among them) re-send a request whose stream was dropped, and
// Otterly drops a failed stream once so that a transient failure recovers on
// its own (dropForRetry in routes-openai.ts); the retry's reasoning opens with
// a notice saying why (retryNotice). The next failure becomes an in-stream
// error, which clients do not retry. An identical request that arrives after
// MAX_ATTEMPTS failures is refused without starting the CLI, until a run
// succeeds, the record expires or the request changes. A failure that repeats
// on every run, retried as if it were transient, would otherwise repeat for
// ever.
//
// The ledger is in memory: each Otterly process keeps its own.

import crypto from "crypto";
import type { ServerResponse } from "http";
import type { RequestOutcome } from "./settle.js";

/**
 * How long a record lives after its last failure or attempt. It must outlast
 * the longest run (DEFAULT_TIMEOUT_MS + CLI_BACKSTOP_MS in engine.ts), so that
 * a record is still there when the attempt after it ends.
 */
export const RETRY_NOTICE_TTL_MS = 60 * 60 * 1000;

/** Failed attempts after which an identical request is no longer run. */
export const MAX_ATTEMPTS = 2;

const MAX_RECORDS = 1000;

interface FailureRecord {
  failures: number;
  reason: string;
  at: number;
}

const records = new Map<string, FailureRecord>();

/** A response, with how Otterly marked its attempt. */
type MarkedResponse = ServerResponse & { otterlyFailure?: string; otterlyRefused?: boolean };

/** Fingerprint of a chat-completion request: its model, messages and tools. */
export function requestFingerprint(body: { model?: unknown; messages?: unknown; tools?: unknown }): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([body.model ?? null, body.messages ?? null, body.tools ?? null]))
    .digest("hex");
}

function fresh(fingerprint: string, now: number): FailureRecord | undefined {
  const record = records.get(fingerprint);
  if (record && now - record.at > RETRY_NOTICE_TTL_MS) {
    records.delete(fingerprint);
    return undefined;
  }
  return record;
}

/** Store a record as the newest, evicting the oldest beyond MAX_RECORDS. */
function store(fingerprint: string, record: FailureRecord): void {
  records.delete(fingerprint);
  records.set(fingerprint, record);
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
}

/** Count one more failed attempt of this request, and why it failed. */
export function recordFailure(fingerprint: string, reason: string, now = Date.now()): void {
  const previous = fresh(fingerprint, now);
  store(fingerprint, { failures: (previous?.failures ?? 0) + 1, reason, at: now });
}

/** How many recent attempts of this request failed (0 if none). */
export function failedAttempts(fingerprint: string, now = Date.now()): number {
  return fresh(fingerprint, now)?.failures ?? 0;
}

/** Why the last failed attempt of this request failed, if one failed recently. */
export function lastFailure(fingerprint: string, now = Date.now()): string | undefined {
  return fresh(fingerprint, now)?.reason;
}

/** A new attempt of this request has started: its record lives on from now. Without a record, nothing changes. */
export function noteAttempt(fingerprint: string, now = Date.now()): void {
  const record = fresh(fingerprint, now);
  if (record) store(fingerprint, { ...record, at: now });
}

/** Forget this request's failures. */
export function clearFailures(fingerprint: string): void {
  records.delete(fingerprint);
}

/** The notice for a retried request, or null when no attempt of it failed recently. */
export function retryNotice(fingerprint: string, now = Date.now()): string | null {
  const record = fresh(fingerprint, now);
  if (!record) return null;
  return `⚠️ Otterly: the previous attempt ${record.reason}, so the request was retried (attempt ${record.failures + 1}).\n\n`;
}

/** Mark a response as a failed attempt, and why. The first reason marked is kept. */
export function markFailure(res: ServerResponse, reason: string): void {
  const marked = res as MarkedResponse;
  if (marked.otterlyFailure === undefined) marked.otterlyFailure = reason;
}

/** Mark a response as a refusal: the request was not run, so its record is left as it is. */
export function markRefused(res: ServerResponse): void {
  (res as MarkedResponse).otterlyRefused = true;
}

/**
 * Settle one attempt once its response has ended. A refusal changes nothing.
 * A failure is counted: one marked with markFailure, a dropped stream, a
 * timeout, or an HTTP status of 500 or more. A success clears the record. A
 * client that hung up, and an HTTP 4xx answer, change nothing.
 */
export function settleAttempt(fingerprint: string, res: ServerResponse, outcome: RequestOutcome, now = Date.now()): void {
  const marked = res as MarkedResponse;
  if (marked.otterlyRefused) return;
  const reason = marked.otterlyFailure
    ?? (outcome === "dropped_for_retry" ? "was dropped"
      : outcome === "timeout" ? "timed out"
      : outcome === "error" && res.statusCode >= 500 ? `failed with HTTP ${res.statusCode}`
      : undefined);
  if (reason !== undefined) recordFailure(fingerprint, reason, now);
  else if (outcome === "ok") clearFailures(fingerprint);
}
