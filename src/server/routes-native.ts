// Native API routes: /api/status, /api/run, /api/stream
// Richer response format than OpenAI compat — includes cost, tools, duration.

import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ClaudeEngine } from "../engine.js";
import type { AgentResult, AgentEvent, EngineOptions } from "../types.js";
import { AgentError } from "../errors.js";
import { apiSessions } from "./session-store.js";
import { errorToHttpStatus } from "./openai-compat.js";
import type { RequestQueue } from "./request-queue.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { logError } from "./logger.js";
import { metrics } from "./metrics.js";

function loadPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/server/routes-native.js → ../../package.json
    for (const candidate of [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
    ]) {
      try {
        const raw = readFileSync(candidate, "utf8");
        const pkg = JSON.parse(raw);
        if (pkg.name === "otterly" && typeof pkg.version === "string") return pkg.version;
      } catch { /* try next */ }
    }
  } catch { /* fall through */ }
  return "0.0.0";
}

export const PKG_VERSION = loadPkgVersion();

export interface ServerContext {
  workingDir: string;
  apiKey: string | null;
}

// Augment req with parsed body and request metadata
export interface ParsedRequest extends IncomingMessage {
  body?: Record<string, unknown>;
  requestId?: string;
  startTime?: number;
  timeoutSignal?: AbortSignal;
}

/**
 * GET /api/status — health check with queue and circuit breaker stats
 */
export function handleStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  queue?: RequestQueue,
  circuitBreaker?: CircuitBreaker,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    version: PKG_VERSION,
    activeSessions: apiSessions.count(),
    ...(queue ? { queue: queue.stats() } : {}),
    ...(circuitBreaker ? { circuitBreaker: circuitBreaker.getState() } : {}),
  }));
}

/**
 * POST /api/run — one-shot execution, returns full result.
 * Supports session reuse via X-Session-Id header or session_id in body.
 */
export async function handleRun(
  req: ParsedRequest,
  res: ServerResponse,
  ctx: ServerContext,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const body = req.body;
  if (!body || !body.prompt || typeof body.prompt !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "prompt is required" }));
    return;
  }

  // Session reuse: check for session ID
  const sessionId = (req.headers["x-session-id"] as string) || (body.session_id as string) || null;
  if (sessionId) {
    const entry = apiSessions.get(sessionId);
    if (entry?.session) {
      const startedAt = Date.now();
      try {
        const result = await entry.session.send(body.prompt as string);
        apiSessions.recordRequest(sessionId, result.cost);
        circuitBreaker?.onSuccess();
        recordRunMetrics("run", 200, startedAt, result);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-Session-Id": result.sessionId || sessionId,
        });
        res.end(JSON.stringify(result));
        return;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        const code = err instanceof AgentError ? err.code : undefined;
        circuitBreaker?.onFailure(code);
        logError(req.requestId || "", e.message);
        const status = errorToHttpStatus(e);
        metrics.record({
          ts: Date.now(),
          endpoint: "run",
          status,
          durationMs: Date.now() - startedAt,
          cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
          error: e.message,
        });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
    }
    // Session not found — fall through to one-shot
  }

  const engine = new ClaudeEngine();
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());
  if (req.timeoutSignal) {
    req.timeoutSignal.addEventListener("abort", () => abortController.abort());
  }

  const options: EngineOptions = {
    cwd: (body.options as Record<string, unknown>)?.cwd as string || ctx.workingDir,
    permissionMode: ((body.options as Record<string, unknown>)?.permissionMode as string) as EngineOptions["permissionMode"] || "bypassPermissions",
    signal: abortController.signal,
  };

  const bodyOpts = body.options as Record<string, unknown> | undefined;
  if (bodyOpts?.systemPrompt) options.systemPrompt = bodyOpts.systemPrompt as string;
  if (bodyOpts?.resume) options.resume = bodyOpts.resume as string;
  if (bodyOpts?.model) options.model = bodyOpts.model as string;
  if (bodyOpts?.maxTurns) options.maxTurns = bodyOpts.maxTurns as number;

  const startedAt = Date.now();
  try {
    const result: AgentResult = await engine.run(body.prompt as string, options);
    circuitBreaker?.onSuccess();
    recordRunMetrics("run", 200, startedAt, result);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name === "AbortError" || abortController.signal.aborted) {
      if (!res.headersSent) {
        res.writeHead(499, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request aborted" }));
      }
      return;
    }
    const code = err instanceof AgentError ? err.code : undefined;
    circuitBreaker?.onFailure(code);
    logError(req.requestId || "", e.message);
    const status = errorToHttpStatus(e);
    metrics.record({
      ts: Date.now(),
      endpoint: "run",
      status,
      durationMs: Date.now() - startedAt,
      cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      error: e.message,
    });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function recordRunMetrics(
  endpoint: "run" | "stream" | "chat",
  status: number,
  startedAt: number,
  result: AgentResult,
): void {
  metrics.record({
    ts: Date.now(),
    endpoint,
    status,
    durationMs: Date.now() - startedAt,
    cost: result.cost || 0,
    inputTokens: result.usage?.input_tokens || 0,
    outputTokens: result.usage?.output_tokens || 0,
    toolCalls: result.tools?.length || 0,
  });
  if (result.tools) {
    for (const t of result.tools) metrics.recordToolUse(t.tool);
  }
}

/**
 * POST /api/stream — streaming execution, NDJSON.
 * Supports session reuse via X-Session-Id header or session_id in body.
 * Includes backpressure: waits for drain when write buffer is full.
 */
export async function handleStream(
  req: ParsedRequest,
  res: ServerResponse,
  ctx: ServerContext,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const body = req.body;
  if (!body || !body.prompt || typeof body.prompt !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "prompt is required" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Transfer-Encoding": "chunked",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  async function sendLine(obj: unknown): Promise<void> {
    if (res.writableEnded) return;
    const ok = res.write(JSON.stringify(obj) + "\n");
    if (!ok) {
      await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  }

  // Session reuse
  const sessionId = (req.headers["x-session-id"] as string) || (body.session_id as string) || null;
  if (sessionId) {
    const entry = apiSessions.get(sessionId);
    if (entry?.session) {
      const startedAt = Date.now();
      let toolCount = 0;
      let lastResult: { cost: number; usage?: { input_tokens?: number; output_tokens?: number } } | null = null;
      try {
        for await (const event of entry.session.sendStream(body.prompt as string)) {
          await sendStreamEvent(event, sendLine);
          if (event.type === "tool_use") {
            toolCount++;
            metrics.recordToolUse(event.tool);
          }
          if (event.type === "result") {
            apiSessions.recordRequest(sessionId, event.cost);
            lastResult = { cost: event.cost, usage: event.usage };
          }
        }
        circuitBreaker?.onSuccess();
        metrics.record({
          ts: Date.now(), endpoint: "stream", status: 200,
          durationMs: Date.now() - startedAt,
          cost: lastResult?.cost || 0,
          inputTokens: lastResult?.usage?.input_tokens || 0,
          outputTokens: lastResult?.usage?.output_tokens || 0,
          toolCalls: toolCount,
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        const code = err instanceof AgentError ? err.code : undefined;
        circuitBreaker?.onFailure(code);
        metrics.record({
          ts: Date.now(), endpoint: "stream", status: 500,
          durationMs: Date.now() - startedAt,
          cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: toolCount,
          error: e.message,
        });
        await sendLine({ type: "error", message: e.message });
      }
      if (!res.writableEnded) res.end();
      return;
    }
  }

  const engine = new ClaudeEngine();
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());
  if (req.timeoutSignal) {
    req.timeoutSignal.addEventListener("abort", () => abortController.abort());
  }

  const options: EngineOptions = {
    cwd: (body.options as Record<string, unknown>)?.cwd as string || ctx.workingDir,
    permissionMode: ((body.options as Record<string, unknown>)?.permissionMode as string) as EngineOptions["permissionMode"] || "bypassPermissions",
    signal: abortController.signal,
  };

  const bodyOpts = body.options as Record<string, unknown> | undefined;
  if (bodyOpts?.systemPrompt) options.systemPrompt = bodyOpts.systemPrompt as string;
  if (bodyOpts?.resume) options.resume = bodyOpts.resume as string;
  if (bodyOpts?.model) options.model = bodyOpts.model as string;

  const startedAt = Date.now();
  let toolCount = 0;
  let lastResult: { cost: number; usage?: { input_tokens?: number; output_tokens?: number } } | null = null;
  try {
    for await (const event of engine.stream(body.prompt as string, options)) {
      if (abortController.signal.aborted) break;
      if (event.type === "tool_use") {
        toolCount++;
        metrics.recordToolUse(event.tool);
      }
      if (event.type === "result") {
        lastResult = { cost: event.cost, usage: event.usage };
      }
      await sendStreamEvent(event, sendLine);
    }
    circuitBreaker?.onSuccess();
    metrics.record({
      ts: Date.now(), endpoint: "stream", status: 200,
      durationMs: Date.now() - startedAt,
      cost: lastResult?.cost || 0,
      inputTokens: lastResult?.usage?.input_tokens || 0,
      outputTokens: lastResult?.usage?.output_tokens || 0,
      toolCalls: toolCount,
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name !== "AbortError" && !abortController.signal.aborted) {
      const code = err instanceof AgentError ? err.code : undefined;
      circuitBreaker?.onFailure(code);
      metrics.record({
        ts: Date.now(), endpoint: "stream", status: 500,
        durationMs: Date.now() - startedAt,
        cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: toolCount,
        error: e.message,
      });
      await sendLine({ type: "error", message: e.message });
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
}

async function sendStreamEvent(
  event: AgentEvent,
  sendLine: (obj: unknown) => Promise<void>,
): Promise<void> {
  switch (event.type) {
    case "system":
      await sendLine({ type: "session_init", sessionId: event.sessionId, model: event.model });
      break;
    case "text_delta":
      await sendLine({ type: "text_delta", delta: event.delta });
      break;
    case "tool_use":
      await sendLine({ type: "tool_use", id: event.id, tool: event.tool, input: event.input, description: event.description });
      break;
    case "tool_result":
      await sendLine({ type: "tool_result", toolUseId: event.toolUseId, tool: event.tool, output: event.output, isError: event.isError });
      break;
    case "result":
      await sendLine({ type: "result", text: event.text, cost: event.cost, duration: event.duration, sessionId: event.sessionId, usage: event.usage });
      break;
    case "error":
      await sendLine({ type: "error", message: event.error.message });
      break;
  }
}
