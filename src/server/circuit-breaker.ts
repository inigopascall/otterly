// Circuit breaker: protects against cascading failures when the upstream API is down.
// States: closed (normal) → open (failing, reject fast) → half-open (probe) → closed

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;  // consecutive failures to trip (default: 5)
  cooldownMs?: number;        // time in open state before probing (default: 30s)
}

const TRIPPABLE_CODES = new Set(["NETWORK", "RATE_LIMITED"]);

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private failureThreshold: number;
  private cooldownMs: number;
  private lastFailureTime = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  /** Check if request should proceed. Returns true if allowed. */
  canProceed(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      // Check if cooldown has elapsed
      if (Date.now() - this.lastFailureTime >= this.cooldownMs) {
        this.state = "half-open";
        return true; // allow one probe
      }
      return false;
    }

    // half-open: already allowing the probe, block others
    return false;
  }

  /** Record a successful execution. */
  onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      this.state = "closed";
    }
  }

  /** Record a failure. Pass the error code from AgentError if available. */
  onFailure(errorCode?: string): void {
    // Only trip on network/rate-limit errors, not auth or user errors
    if (errorCode && !TRIPPABLE_CODES.has(errorCode)) return;

    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      this.state = "open";
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}
