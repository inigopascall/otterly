import { describe, it, expect } from "vitest";
import { classifyError, AgentError } from "../src/errors.js";

describe("classifyError", () => {
  it("classifies API key errors as NOT_AUTHENTICATED", () => {
    const err = classifyError(new Error("Missing ANTHROPIC_API_KEY"));
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe("NOT_AUTHENTICATED");
    expect(err.message).toContain("claude login");
  });

  it("classifies authentication errors", () => {
    const err = classifyError(new Error("authentication failed"));
    expect(err.code).toBe("NOT_AUTHENTICATED");
  });

  it("classifies 'not logged in' errors", () => {
    const err = classifyError(new Error("not logged in"));
    expect(err.code).toBe("NOT_AUTHENTICATED");
  });

  it("classifies 'claude login' errors", () => {
    const err = classifyError(new Error("Please run claude login first"));
    expect(err.code).toBe("NOT_AUTHENTICATED");
  });

  it("classifies rate limit errors", () => {
    const err = classifyError(new Error("rate_limit exceeded"));
    expect(err.code).toBe("RATE_LIMITED");
  });

  it("classifies 429 errors", () => {
    const err = classifyError(new Error("Request failed with status 429"));
    expect(err.code).toBe("RATE_LIMITED");
  });

  it("classifies billing errors", () => {
    const err = classifyError(new Error("billing issue on account"));
    expect(err.code).toBe("BILLING");
  });

  it("classifies 402 errors", () => {
    const err = classifyError(new Error("HTTP 402 Payment Required"));
    expect(err.code).toBe("BILLING");
  });

  it("classifies network errors", () => {
    const err = classifyError(new Error("ECONNREFUSED"));
    expect(err.code).toBe("NETWORK");
  });

  it("classifies fetch failures", () => {
    const err = classifyError(new Error("fetch failed"));
    expect(err.code).toBe("NETWORK");
  });

  it("classifies abort errors", () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const err = classifyError(abortErr);
    expect(err.code).toBe("ABORTED");
  });

  it("classifies unknown errors", () => {
    const err = classifyError(new Error("something unexpected"));
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("something unexpected");
  });

  it("wraps non-Error values", () => {
    const err = classifyError("string error");
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe("UNKNOWN");
  });

  it("passes through existing AgentErrors", () => {
    const original = new AgentError("SDK_NOT_FOUND", "not found");
    const err = classifyError(original);
    expect(err).toBe(original);
  });

  it("preserves the original error", () => {
    const original = new Error("rate_limit");
    const err = classifyError(original);
    expect(err.original).toBe(original);
  });
});
