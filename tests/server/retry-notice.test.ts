import { describe, it, expect } from "vitest";
import type { ServerResponse } from "http";
import {
  requestFingerprint,
  recordFailure,
  failedAttempts,
  lastFailure,
  noteAttempt,
  clearFailures,
  retryNotice,
  markFailure,
  markRefused,
  settleAttempt,
  RETRY_NOTICE_TTL_MS,
  MAX_ATTEMPTS,
} from "../../src/server/retry-notice.js";
import { DEFAULT_TIMEOUT_MS, CLI_BACKSTOP_MS } from "../../src/engine.js";

const body = (content: string) => ({
  model: "m",
  messages: [{ role: "user", content }],
  tools: [{ type: "function", function: { name: "f" } }],
});
const MIN = 60 * 1000;
/** A stand-in response with the given status, as settleAttempt sees it. */
const response = (statusCode = 200) => ({ statusCode }) as unknown as ServerResponse;

describe("the attempt ledger", () => {
  it("fingerprints equal bodies equally and different messages differently", () => {
    expect(requestFingerprint(body("a"))).toBe(requestFingerprint(body("a")));
    expect(requestFingerprint(body("a"))).not.toBe(requestFingerprint(body("b")));
  });

  it("counts failures and keeps the last reason", () => {
    const fp = requestFingerprint(body("count"));
    expect(failedAttempts(fp)).toBe(0);
    expect(lastFailure(fp)).toBeUndefined();
    expect(retryNotice(fp)).toBeNull();
    recordFailure(fp, "went quiet");
    recordFailure(fp, "was dropped");
    expect(failedAttempts(fp)).toBe(2);
    expect(lastFailure(fp)).toBe("was dropped");
    const notice = retryNotice(fp)!;
    expect(notice.startsWith("⚠️ Otterly: the previous attempt was dropped")).toBe(true);
    expect(notice).toContain("(attempt 3)");
  });

  it("allows two attempts", () => {
    expect(MAX_ATTEMPTS).toBe(2);
  });

  it("keeps a record fresh across a 46-minute gap between two failures", () => {
    const fp = requestFingerprint(body("gap"));
    const t0 = 1_000_000;
    recordFailure(fp, "went quiet", t0);
    recordFailure(fp, "went quiet", t0 + 46 * MIN);
    expect(failedAttempts(fp, t0 + 46 * MIN)).toBe(2);
  });

  it("extends a record's life with noteAttempt, and does nothing without a record", () => {
    const fp = requestFingerprint(body("note"));
    const t0 = 2_000_000;
    recordFailure(fp, "went quiet", t0);
    noteAttempt(fp, t0 + 50 * MIN);
    expect(failedAttempts(fp, t0 + 50 * MIN + RETRY_NOTICE_TTL_MS)).toBe(1);
    expect(failedAttempts(fp, t0 + 50 * MIN + RETRY_NOTICE_TTL_MS + 1)).toBe(0);
    const none = requestFingerprint(body("note none"));
    noteAttempt(none, t0);
    expect(failedAttempts(none, t0)).toBe(0);
  });

  it("expires a record after RETRY_NOTICE_TTL_MS", () => {
    const fp = requestFingerprint(body("expiry"));
    recordFailure(fp, "went quiet", 1000);
    expect(failedAttempts(fp, 1000 + RETRY_NOTICE_TTL_MS)).toBe(1);
    expect(retryNotice(fp, 1000 + RETRY_NOTICE_TTL_MS)).not.toBeNull();
    expect(failedAttempts(fp, 1000 + RETRY_NOTICE_TTL_MS + 1)).toBe(0);
    expect(retryNotice(fp, 1000 + RETRY_NOTICE_TTL_MS + 1)).toBeNull();
  });

  it("outlasts the longest run", () => {
    expect(RETRY_NOTICE_TTL_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS + CLI_BACKSTOP_MS);
  });

  it("forgets a request after clearFailures", () => {
    const fp = requestFingerprint(body("clear"));
    recordFailure(fp, "went quiet");
    clearFailures(fp);
    expect(failedAttempts(fp)).toBe(0);
    expect(retryNotice(fp)).toBeNull();
  });
});

describe("settleAttempt", () => {
  it("changes nothing for a refused response, even one marked as failed", () => {
    const fp = requestFingerprint(body("settle refused"));
    recordFailure(fp, "was dropped");
    const res = response(400);
    markFailure(res, "Otterly did not run this request");
    markRefused(res);
    settleAttempt(fp, res, "error");
    expect(failedAttempts(fp)).toBe(1);
    expect(lastFailure(fp)).toBe("was dropped");
  });

  it("counts a marked failure with its reason, whatever the outcome, and keeps the first reason marked", () => {
    const fp = requestFingerprint(body("settle marked"));
    const res = response(200);
    markFailure(res, "stopped before its tool request was complete");
    markFailure(res, "a later message");
    settleAttempt(fp, res, "ok");
    expect(failedAttempts(fp)).toBe(1);
    expect(lastFailure(fp)).toBe("stopped before its tool request was complete");
  });

  it.each<[string, Parameters<typeof settleAttempt>[2], number, string]>([
    ["dropped_for_retry", "dropped_for_retry", 200, "was dropped"],
    ["timeout", "timeout", 504, "timed out"],
    ["error 502", "error", 502, "failed with HTTP 502"],
  ])("counts %s", (label, outcome, status, reason) => {
    const fp = requestFingerprint(body(`settle ${label}`));
    settleAttempt(fp, response(status), outcome);
    expect(failedAttempts(fp)).toBe(1);
    expect(lastFailure(fp)).toBe(reason);
  });

  it.each<[string, Parameters<typeof settleAttempt>[2], number]>([
    ["error 400", "error", 400],
    ["client_disconnected", "client_disconnected", 200],
  ])("changes nothing for %s", (label, outcome, status) => {
    const fp = requestFingerprint(body(`settle ${label}`));
    recordFailure(fp, "was dropped");
    settleAttempt(fp, response(status), outcome);
    expect(failedAttempts(fp)).toBe(1);
  });

  it("clears the record for ok", () => {
    const fp = requestFingerprint(body("settle ok"));
    recordFailure(fp, "was dropped");
    settleAttempt(fp, response(200), "ok");
    expect(failedAttempts(fp)).toBe(0);
  });
});
