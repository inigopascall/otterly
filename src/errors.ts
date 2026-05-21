export type ErrorCode =
  | "NOT_AUTHENTICATED"
  | "RATE_LIMITED"
  | "BILLING"
  | "NETWORK"
  | "ABORTED"
  | "SDK_NOT_FOUND"
  | "UNKNOWN";

export class AgentError extends Error {
  code: ErrorCode;
  original?: Error;

  constructor(code: ErrorCode, message: string, original?: Error) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.original = original;
  }
}

export function classifyError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;

  const e = err instanceof Error ? err : new Error(String(err));
  const msg = e.message || String(err);

  if (msg.includes("ANTHROPIC_API_KEY") || msg.includes("authentication") || msg.includes("not logged in") || msg.includes("claude login")) {
    return new AgentError(
      "NOT_AUTHENTICATED",
      "Not authenticated. Run `claude login` to sign in.",
      e
    );
  }

  if (msg.includes("rate_limit") || msg.includes("429")) {
    return new AgentError(
      "RATE_LIMITED",
      "Rate limited by the API. Wait a moment and try again.",
      e
    );
  }

  if (msg.includes("billing") || msg.includes("402")) {
    return new AgentError(
      "BILLING",
      "Billing issue with your API key. Check your Anthropic account.",
      e
    );
  }

  if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
    return new AgentError(
      "NETWORK",
      "Network error. Check your internet connection.",
      e
    );
  }

  if (e.name === "AbortError" || msg.includes("aborted")) {
    return new AgentError("ABORTED", "Operation was cancelled.", e);
  }

  return new AgentError("UNKNOWN", msg, e);
}
