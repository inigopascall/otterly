// Shared auth check and token-bucket rate limiter.

import type { IncomingMessage, ServerResponse } from "http";
import type { ServerContext } from "./routes-native.js";

// ── Auth ──

export function checkAuth(req: IncomingMessage, ctx: ServerContext): boolean {
  if (!ctx.apiKey) return true;
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return token === ctx.apiKey;
}

// ── Rate Limiting ──

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterOptions {
  requestsPerMinute?: number;
}

export class RateLimiter {
  private requestsPerMinute: number;
  private buckets = new Map<string, TokenBucket>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(opts: RateLimiterOptions = {}) {
    this.requestsPerMinute = opts.requestsPerMinute ?? 60;
    // Sweep stale buckets every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  /** Returns true if allowed, false if rate-limited. */
  allow(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.requestsPerMinute, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / 60_000) * this.requestsPerMinute;
    bucket.tokens = Math.min(this.requestsPerMinute, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /** Get the client key from a request (IP-based). */
  keyFor(req: IncomingMessage): string {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket.remoteAddress
      || "unknown";
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  private cleanup(): void {
    const now = Date.now();
    const staleMs = 10 * 60 * 1000; // 10 minutes
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > staleMs) {
        this.buckets.delete(key);
      }
    }
  }
}

// ── Middleware helpers ──

export function sendAuthError(res: ServerResponse, format: "openai" | "native"): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  if (format === "openai") {
    res.end(JSON.stringify({
      error: { message: "Invalid API key", type: "authentication_error", code: 401 },
    }));
  } else {
    res.end(JSON.stringify({ error: "Invalid API key" }));
  }
}

export function sendRateLimitError(res: ServerResponse, format: "openai" | "native"): void {
  res.writeHead(429, { "Content-Type": "application/json" });
  if (format === "openai") {
    res.end(JSON.stringify({
      error: { message: "Rate limit exceeded. Try again later.", type: "rate_limit_error", code: 429 },
    }));
  } else {
    res.end(JSON.stringify({ error: "Rate limit exceeded. Try again later." }));
  }
}
