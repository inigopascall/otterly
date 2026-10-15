// Structured JSON logger. Writes JSON lines to stdout.

import crypto from "crypto";
import { traceEnabled, traceLog } from "./trace.js";

export type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  message?: string;
  [key: string]: unknown;
}

export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function log(level: LogLevel, fields: Omit<LogEntry, "timestamp" | "level">): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    ...fields,
  };
  const line = JSON.stringify(entry) + "\n";
  process.stdout.write(line);
  if (traceEnabled()) traceLog(line);
}

/**
 * Diagnostic logging. These entries carry prompt and response excerpts, which
 * would flood the terminal the server runs in, so they go to the trace file
 * ONLY. Set OTTERLY_LOG_VERBOSE=1 to also print them to stdout.
 *
 * With neither OTTERLY_TRACE nor OTTERLY_LOG_VERBOSE set, nothing is written
 * and the call costs one env lookup.
 */
export function logDiag(level: LogLevel, fields: Omit<LogEntry, "timestamp" | "level">): void {
  const verbose = process.env.OTTERLY_LOG_VERBOSE === "1";
  if (!verbose && !traceEnabled()) return;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    ...fields,
  };
  const line = JSON.stringify(entry) + "\n";
  if (verbose) process.stdout.write(line);
  if (traceEnabled()) traceLog(line);
}

export function logRequest(requestId: string, method: string, path: string): void {
  log("info", { requestId, method, path, message: "request_start" });
}

export function logResponse(requestId: string, method: string, path: string, status: number, durationMs: number, outcome?: string): void {
  log("info", { requestId, method, path, status, durationMs, ...(outcome ? { outcome } : {}), message: "request_end" });
}

export function logError(requestId: string, message: string, extra?: Record<string, unknown>): void {
  log("error", { requestId, message, ...extra });
}
