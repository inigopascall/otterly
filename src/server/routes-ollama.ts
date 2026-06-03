// Ollama-native API routes: /api/chat, /api/generate, /api/show, /api/pull.
// (/api/tags, /api/version, /api/ps are tiny and served inline from index.ts.)
//
// These let Ollama-only tooling talk to otterly without changes. /api/chat and
// /api/generate spawn Claude and therefore run through the same auth → rate-limit
// → circuit-breaker → queue pipeline as the other POST routes. /api/show and
// /api/pull are pure metadata and answered directly.

import type { ServerResponse } from "http";
import { ClaudeEngine } from "../engine.js";
import { AgentError } from "../errors.js";
import type { EngineOptions } from "../types.js";
import type { ParsedRequest, ServerContext } from "./routes-native.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { logError } from "./logger.js";
import { metrics } from "./metrics.js";
import { errorToHttpStatus } from "./openai-compat.js";
import { DEFAULT_MODEL } from "./models.js";
import {
  ollamaMessagesToClaudeInput,
  buildOllamaShow,
  ollamaChatResponse,
  ollamaChatChunk,
  ollamaChatFinal,
  ollamaGenerateResponse,
  ollamaGenerateChunk,
  ollamaGenerateFinal,
  type OllamaChatRequest,
  type OllamaGenerateRequest,
} from "./ollama-compat.js";

function ollamaError(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** POST /api/show — model metadata. No Claude spawn. */
export function handleOllamaShow(body: Record<string, unknown> | undefined, res: ServerResponse): void {
  const model = (body?.model || body?.name) as string | undefined;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(buildOllamaShow(model)));
}

/** POST /api/pull — we have no model files to fetch; report success so that
 *  "pull then chat" flows in tools like Open WebUI proceed. */
export async function handleOllamaPull(
  body: Record<string, unknown> | undefined,
  res: ServerResponse,
): Promise<void> {
  const stream = body?.stream !== false;
  if (!stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "success" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
  res.end(JSON.stringify({ status: "success" }) + "\n");
}

/** POST /api/chat — Ollama chat completion (conversational). */
export async function handleOllamaChat(
  req: ParsedRequest,
  res: ServerResponse,
  ctx: ServerContext,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const body = req.body as unknown as OllamaChatRequest | undefined;
  if (!body || !Array.isArray(body.messages)) {
    ollamaError(res, 400, "messages array is required");
    return;
  }
  const model = body.model || DEFAULT_MODEL;
  const stream = body.stream !== false; // Ollama defaults stream to true
  const { prompt, systemPrompt } = ollamaMessagesToClaudeInput(body.messages, body.system);
  await runOllama(req, res, ctx, circuitBreaker, { kind: "chat", model, stream, prompt, systemPrompt });
}

/** POST /api/generate — Ollama single-prompt completion. */
export async function handleOllamaGenerate(
  req: ParsedRequest,
  res: ServerResponse,
  ctx: ServerContext,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const body = req.body as unknown as OllamaGenerateRequest | undefined;
  if (!body || typeof body.prompt !== "string") {
    ollamaError(res, 400, "prompt is required");
    return;
  }
  const model = body.model || DEFAULT_MODEL;
  const stream = body.stream !== false;
  await runOllama(req, res, ctx, circuitBreaker, {
    kind: "generate",
    model,
    stream,
    prompt: body.prompt,
    systemPrompt: body.system || null,
  });
}

interface RunSpec {
  kind: "chat" | "generate";
  model: string;
  stream: boolean;
  prompt: string;
  systemPrompt: string | null;
}

async function runOllama(
  req: ParsedRequest,
  res: ServerResponse,
  ctx: ServerContext,
  circuitBreaker: CircuitBreaker | undefined,
  spec: RunSpec,
): Promise<void> {
  const engine = new ClaudeEngine();
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());
  if (req.timeoutSignal) {
    req.timeoutSignal.addEventListener("abort", () => abortController.abort());
  }

  const options: EngineOptions = {
    cwd: ctx.workingDir,
    permissionMode: "bypassPermissions",
    signal: abortController.signal,
    model: spec.model,
  };
  if (spec.systemPrompt) options.systemPrompt = spec.systemPrompt;

  const startedAt = Date.now();

  // Build the NDJSON line writer (streaming) with backpressure.
  async function sendLine(obj: unknown): Promise<void> {
    if (res.writableEnded) return;
    const ok = res.write(JSON.stringify(obj) + "\n");
    if (!ok) await new Promise<void>((resolve) => res.once("drain", resolve));
  }

  const chunk = (text: string) =>
    spec.kind === "chat" ? ollamaChatChunk(spec.model, text) : ollamaGenerateChunk(spec.model, text);
  const final = (stats: { promptTokens?: number; outputTokens?: number; totalMs?: number }) =>
    spec.kind === "chat" ? ollamaChatFinal(spec.model, stats) : ollamaGenerateFinal(spec.model, stats);
  const whole = (text: string, stats: { promptTokens?: number; outputTokens?: number; totalMs?: number }) =>
    spec.kind === "chat"
      ? ollamaChatResponse(spec.model, text, stats)
      : ollamaGenerateResponse(spec.model, text, stats);

  try {
    if (spec.stream) {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      let toolCount = 0;
      let usage: { input_tokens?: number; output_tokens?: number } | undefined;
      let cost = 0;
      let sawDelta = false;
      for await (const event of engine.stream(spec.prompt, options)) {
        if (abortController.signal.aborted) break;
        if (event.type === "tool_use") {
          toolCount++;
          metrics.recordToolUse(event.tool);
        } else if (event.type === "text_delta") {
          sawDelta = true;
          await sendLine(chunk(event.delta));
        } else if (event.type === "text") {
          // CLI mode emits the full answer as one `text` event. SDK mode also
          // emits a trailing full-text block after the deltas — skip it there to
          // avoid duplicating the content we already streamed.
          if (event.text && !sawDelta) await sendLine(chunk(event.text));
        } else if (event.type === "result") {
          usage = event.usage;
          cost = event.cost;
        }
      }
      await sendLine(final({
        promptTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        totalMs: Date.now() - startedAt,
      }));
      if (!res.writableEnded) res.end();

      circuitBreaker?.onSuccess();
      metrics.record({
        ts: Date.now(), endpoint: "chat", status: 200,
        durationMs: Date.now() - startedAt,
        cost,
        inputTokens: usage?.input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        toolCalls: toolCount,
      });
    } else {
      const result = await engine.run(spec.prompt, options);
      circuitBreaker?.onSuccess();
      metrics.record({
        ts: Date.now(), endpoint: "chat", status: 200,
        durationMs: Date.now() - startedAt,
        cost: result.cost || 0,
        inputTokens: result.usage?.input_tokens || 0,
        outputTokens: result.usage?.output_tokens || 0,
        toolCalls: result.tools?.length || 0,
      });
      for (const t of result.tools || []) metrics.recordToolUse(t.tool);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(whole(result.text, {
        promptTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
        totalMs: Date.now() - startedAt,
      })));
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name === "AbortError" || abortController.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    const code = err instanceof AgentError ? err.code : undefined;
    circuitBreaker?.onFailure(code);
    logError(req.requestId || "", e.message);
    const status = errorToHttpStatus(e);
    metrics.record({
      ts: Date.now(), endpoint: "chat", status,
      durationMs: Date.now() - startedAt,
      cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      error: e.message,
    });
    if (res.headersSent) {
      // Mid-stream failure: emit a final NDJSON line carrying the error.
      if (!res.writableEnded) res.end(JSON.stringify({ error: e.message }) + "\n");
    } else {
      ollamaError(res, status, e.message);
    }
  }
}
