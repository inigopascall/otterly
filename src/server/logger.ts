// Structured JSON logger. Writes JSON lines to stdout.

import crypto from "crypto";

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
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export function logRequest(requestId: string, method: string, path: string): void {
  log("info", { requestId, method, path, message: "request_start" });
}

export function logResponse(requestId: string, method: string, path: string, status: number, durationMs: number): void {
  log("info", { requestId, method, path, status, durationMs, message: "request_end" });
}

export function logError(requestId: string, message: string, extra?: Record<string, unknown>): void {
  log("error", { requestId, message, ...extra });
}
