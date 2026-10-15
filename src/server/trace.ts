// File-based request tracing. Off unless OTTERLY_TRACE=1 or OTTERLY_TRACE_DIR
// is set. When on, each request gets its own directory holding the exact bytes
// at every stage: the prompt sent to the CLI, the raw NDJSON the CLI printed,
// and the text we returned.
//
// Nothing here may throw: tracing must never take down a request.

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
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

/** Mirror one structured log line into the trace root's combined log file. */
export function traceLog(line: string): void {
  if (!ensureRoot()) return;
  try {
    appendFileSync(join(root, "otterly.log"), line.endsWith("\n") ? line : line + "\n");
  } catch { /* ignore */ }
}

/** Append text exactly as given (no newline added) to a file in a request's trace directory. */
export function traceAppendRaw(traceId: string, name: string, text: string): void {
  const dir = traceDir(traceId);
  if (!dir) return;
  try {
    appendFileSync(join(dir, name), text);
  } catch { /* tracing must never break a request */ }
}
