import { describe, it, expect } from "vitest";
import { requestFingerprint, recordDrop, retryNotice, clearDrop, RETRY_NOTICE_TTL_MS } from "../../src/server/retry-notice.js";

const body = (content: string) => ({
  model: "m",
  messages: [{ role: "user", content }],
  tools: [{ type: "function", function: { name: "f" } }],
});

describe("retry notice", () => {
  it("fingerprints equal bodies equally and different messages differently", () => {
    expect(requestFingerprint(body("a"))).toBe(requestFingerprint(body("a")));
    expect(requestFingerprint(body("a"))).not.toBe(requestFingerprint(body("b")));
  });

  it("counts attempts across drops", () => {
    const fp = requestFingerprint(body("attempts"));
    expect(retryNotice(fp)).toBeNull();
    recordDrop(fp, "went quiet");
    recordDrop(fp, "went quiet");
    const notice = retryNotice(fp)!;
    expect(notice.startsWith("⚠️ Otterly: the previous attempt")).toBe(true);
    expect(notice).toContain("(attempt 3)");
  });

  it("expires after RETRY_NOTICE_TTL_MS", () => {
    const fp = requestFingerprint(body("expiry"));
    recordDrop(fp, "went quiet", 1000);
    expect(retryNotice(fp, 1000 + RETRY_NOTICE_TTL_MS)).not.toBeNull();
    expect(retryNotice(fp, 1000 + RETRY_NOTICE_TTL_MS + 1)).toBeNull();
  });

  it("forgets a request after clearDrop", () => {
    const fp = requestFingerprint(body("clear"));
    recordDrop(fp, "went quiet");
    clearDrop(fp);
    expect(retryNotice(fp)).toBeNull();
  });
});
