// Remembers requests whose SSE stream Otterly dropped on purpose, so that the
// client's retry of the same request can be told why.
//
// Dropping the connection is the one failure an OpenAI-compatible client on the
// AI SDK (AiderDesk among them) retries by itself; it discards the partial reply
// and re-sends the same body. That body's fingerprint finds the record here, and
// the retried response opens its reasoning stream with a short notice.

import crypto from "crypto";

/** How long a dropped request is remembered. */
export const RETRY_NOTICE_TTL_MS = 10 * 60 * 1000;

const MAX_RECORDS = 200;

interface DropRecord {
  drops: number;
  reason: string;
  at: number;
}

const records = new Map<string, DropRecord>();

/** Fingerprint of a chat-completion request: its model, messages and tools. */
export function requestFingerprint(body: { model?: unknown; messages?: unknown; tools?: unknown }): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([body.model ?? null, body.messages ?? null, body.tools ?? null]))
    .digest("hex");
}

function fresh(fingerprint: string, now: number): DropRecord | undefined {
  const record = records.get(fingerprint);
  if (record && now - record.at > RETRY_NOTICE_TTL_MS) {
    records.delete(fingerprint);
    return undefined;
  }
  return record;
}

/** Record that the stream for this request was dropped, and why. */
export function recordDrop(fingerprint: string, reason: string, now = Date.now()): void {
  const previous = fresh(fingerprint, now);
  records.delete(fingerprint);
  records.set(fingerprint, { drops: (previous?.drops ?? 0) + 1, reason, at: now });
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
}

/** The notice for a retried request, or null when the request was not dropped. */
export function retryNotice(fingerprint: string, now = Date.now()): string | null {
  const record = fresh(fingerprint, now);
  if (!record) return null;
  return `⚠️ Otterly: the previous attempt ${record.reason}, so the request was retried (attempt ${record.drops + 1}).\n\n`;
}

/** How many times this request has been dropped recently (0 if never). */
export function dropCount(fingerprint: string, now = Date.now()): number {
  return fresh(fingerprint, now)?.drops ?? 0;
}

/** Forget a request once a response to it has completed. */
export function clearDrop(fingerprint: string): void {
  records.delete(fingerprint);
}
