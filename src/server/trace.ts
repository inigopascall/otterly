// File-based request tracing. Off unless OTTERLY_TRACE=1 or OTTERLY_TRACE_DIR
// is set. When on, each request gets its own directory holding the exact bytes
// at every stage: the prompt sent to the CLI, the raw NDJSON the CLI printed,
// and the text we returned.
//
// Nothing here may throw: tracing must never take down a request.

import { appendFileSync, mkdirSync, writeFileSync, readdirSync, rmSync, renameSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const enabled = process.env.OTTERLY_TRACE === "1" || !!process.env.OTTERLY_TRACE_DIR;
const root = process.env.OTTERLY_TRACE_DIR || join(homedir(), ".otterly", "traces");

let rootReady = false;
const dirs = new Map<string, string>();

export function traceEnabled(): boolean {
  return enabled;
}

export function traceRoot(): string {
  return root;
}

function ensureRoot(): boolean {
  if (!enabled) return false;
  if (rootReady) return true;
  try {
    mkdirSync(root, { recursive: true });
    rootReady = true;
    return true;
  } catch {
    return false;
  }
}

/** Directory for one request, created on first use. Returns "" when disabled. */
export function traceDir(traceId: string): string {
  if (!ensureRoot() || !traceId) return "";
  const existing = dirs.get(traceId);
  if (existing) return existing;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(root, `${stamp}-${traceId}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return "";
  }
  dirs.set(traceId, dir);
  if (dirs.size > 500) {
    const oldest = dirs.keys().next().value;
    if (oldest !== undefined) dirs.delete(oldest);
  }
  return dir;
}

/** Write one whole file into a request's trace directory. */
export function traceWrite(traceId: string, name: string, body: string): string {
  const dir = traceDir(traceId);
  if (!dir) return "";
  const path = join(dir, name);
  try {
    writeFileSync(path, body);
    return path;
  } catch {
    return "";
  }
}

/** Append one line to a file in a request's trace directory. */
export function traceAppend(traceId: string, name: string, line: string): void {
  const dir = traceDir(traceId);
  if (!dir) return;
  try {
    appendFileSync(join(dir, name), line.endsWith("\n") ? line : line + "\n");
  } catch { /* tracing must never break a request */ }
}

/** otterly.log is rotated once it reaches this size; LOG_KEEP old files are kept. */
export const LOG_ROTATE_BYTES = 50 * 1024 * 1024;
export const LOG_KEEP = 3;

let logWrites = 0;

/** Rotate otterly.log to otterly.log.1 (and .1 to .2, ...) when it is too large. */
function rotateLogIfNeeded(): void {
  const file = join(root, "otterly.log");
  try {
    if (!existsSync(file) || statSync(file).size < LOG_ROTATE_BYTES) return;
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  } catch { /* ignore */ }
}

/** Mirror one structured log line into the trace root's combined log file. */
export function traceLog(line: string): void {
  if (!ensureRoot()) return;
  if (logWrites++ % 500 === 0) rotateLogIfNeeded();
  try {
    appendFileSync(join(root, "otterly.log"), line.endsWith("\n") ? line : line + "\n");
  } catch { /* ignore */ }
}

/** Trace directories older than this many days are deleted. OTTERLY_TRACE_RETENTION_DAYS overrides it. */
export const DEFAULT_TRACE_RETENTION_DAYS = 7;

function retentionDays(): number {
  const n = Number(process.env.OTTERLY_TRACE_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRACE_RETENTION_DAYS;
}

/** Delete trace directories last modified more than `days` days ago. Returns how many were deleted. */
export function pruneTraces(days = retentionDays(), now = Date.now()): number {
  if (!enabled) return 0;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      try {
        if (statSync(dir).mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          removed++;
        }
      } catch { /* skip */ }
    }
  } catch { /* root missing */ }
  return removed;
}

/** Prune now, then hourly. Does nothing when tracing is off. */
export function startTraceRetention(): void {
  if (!enabled) return;
  pruneTraces();
  const t = setInterval(() => pruneTraces(), 60 * 60 * 1000);
  t.unref?.();
}

/** Append text exactly as given (no newline added) to a file in a request's trace directory. */
export function traceAppendRaw(traceId: string, name: string, text: string): void {
  const dir = traceDir(traceId);
  if (!dir) return;
  try {
    appendFileSync(join(dir, name), text);
  } catch { /* tracing must never break a request */ }
}
