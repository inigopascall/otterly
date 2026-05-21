// In-memory store for active API/WebSocket sessions.
// LRU eviction, max session limit, idle timeout.

import type { Session } from "../session.js";

export interface SessionStoreOptions {
  maxSessions?: number;
  idleTimeoutMs?: number;
}

export interface SessionMetadata {
  createdAt: number;
  lastActivity: number;
  requestCount: number;
  totalCost: number;
}

interface SessionEntry {
  session?: Session;
  abortController?: AbortController;
  metadata: SessionMetadata;
  [key: string]: unknown;
}

class ApiSessionStore {
  private sessions = new Map<string, SessionEntry>();
  private sweepInterval: ReturnType<typeof setInterval>;
  private maxSessions: number;
  private idleTimeoutMs: number;

  constructor(opts: SessionStoreOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 20;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000; // 30 min
    this.sweepInterval = setInterval(() => this.sweepIdle(), 5 * 60 * 1000);
    this.sweepInterval.unref();
  }

  create(id: string, data: Record<string, unknown>): string {
    // Evict LRU if at capacity
    if (this.sessions.size >= this.maxSessions && !this.sessions.has(id)) {
      this.evictLRU();
    }

    const now = Date.now();
    this.sessions.set(id, {
      ...data,
      metadata: {
        createdAt: now,
        lastActivity: now,
        requestCount: 0,
        totalCost: 0,
      },
    });
    return id;
  }

  get(id: string): SessionEntry | null {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.metadata.lastActivity = Date.now();
      // Move to end of map for LRU ordering (Map preserves insertion order)
      this.sessions.delete(id);
      this.sessions.set(id, entry);
    }
    return entry || null;
  }

  /** Record a request against a session (bumps count and cost). */
  recordRequest(id: string, cost: number): void {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.metadata.requestCount++;
      entry.metadata.totalCost += cost;
      entry.metadata.lastActivity = Date.now();
    }
  }

  delete(id: string): void {
    const entry = this.sessions.get(id);
    if (entry) {
      if (entry.session && typeof entry.session.close === "function") {
        entry.session.close();
      }
      if (entry.abortController) {
        entry.abortController.abort();
      }
      this.sessions.delete(id);
    }
  }

  count(): number {
    return this.sessions.size;
  }

  sweepIdle(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.metadata.lastActivity > this.idleTimeoutMs) {
        this.delete(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.sweepInterval);
    for (const id of [...this.sessions.keys()]) {
      this.delete(id);
    }
  }

  /** Evict the least-recently-used session (first item in Map). */
  private evictLRU(): void {
    const firstKey = this.sessions.keys().next().value;
    if (firstKey !== undefined) {
      this.delete(firstKey);
    }
  }
}

export const apiSessions = new ApiSessionStore();
