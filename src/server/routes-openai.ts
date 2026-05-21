// POST /v1/chat/completions — OpenAI-compatible endpoint.
// Supports streaming (SSE) and non-streaming responses.
// Auth is handled by middleware in index.ts — not checked here.

import type { ServerResponse } from "http";
import crypto from "crypto";
import { ClaudeEngine } from "../engine.js";
import { AgentError } from "../errors.js";
import type { EngineOptions } from "../types.js";
import type { ParsedRequest, ServerContext } from "./routes-native.js";
import { apiSessions } from "./session-store.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { logError } from "./logger.js";
import {
  openaiToClaudeInput,
  claudeResultToOpenai,
  makeStreamChunk,
  sseData,
  errorToHttpStatus,
  openaiErrorBody,
  openaiToolsToAllowedTools,
  type OpenAIChatRequest,
} from "./openai-compat.js";

/**
 * Handle POST /v1/chat/completions
 */
export async function handleChatCompletions(
  req: ParsedRequest,
  res: ServerResponse,
  ctx: ServerContext,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  // Auth is now handled by middleware in index.ts

  const body = req.body as unknown as OpenAIChatRequest | undefined;
  if (!body || !body.messages || !Array.isArray(body.messages)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(openaiErrorBody(400, "messages array is required")));
    return;
  }

  const { prompt, systemPrompt, isMultimodal } = openaiToClaudeInput(body);
  const model = body.model || "claude-sonnet-4-20250514";
  const stream = body.stream === true;

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());
  if (req.timeoutSignal) {
    req.timeoutSignal.addEventListener("abort", () => abortController.abort());
  }

  const options: EngineOptions = {
    cwd: ctx.workingDir,
    permissionMode: "bypassPermissions",
    signal: abortController.signal,
  };

  // Build system prompt: original + JSON mode injection
  let finalSystemPrompt = systemPrompt || "";
  if (body.response_format?.type === "json_object") {
    const jsonInstruction = "You must respond with valid JSON only. No markdown, no explanation, no code fences, just a JSON object.";
    finalSystemPrompt = finalSystemPrompt
      ? `${finalSystemPrompt}\n\n${jsonInstruction}`
      : jsonInstruction;
  }
  if (finalSystemPrompt) {
    options.systemPrompt = finalSystemPrompt;
  }

  if (model) {
    options.model = model;
  }

  // Tools parameter → allowedTools filter
  if (body.tools && Array.isArray(body.tools)) {
    const allowed = openaiToolsToAllowedTools(body.tools);
    if (allowed.length > 0) {
      options.allowedTools = allowed;
    }
  }

  // Session reuse via X-Session-Id header or session_id in body
  const sessionId = (req.headers["x-session-id"] as string)
    || (body as unknown as Record<string, unknown>).session_id as string
    || null;

  if (sessionId) {
    const entry = apiSessions.get(sessionId);
    if (entry?.session) {
      if (stream) {
        await handleSessionStreaming(req, res, entry.session, prompt, model, sessionId, circuitBreaker);
      } else {
        await handleSessionNonStreaming(req, res, entry.session, prompt, model, sessionId, circuitBreaker);
      }
      return;
    }
    // Session not found — fall through to one-shot
  }

  // Multimodal: for now, add a note to the prompt about image content.
  // Full multimodal requires session-based path with SDKUserMessage.
  // This is a pragmatic approach that works for most cases.

  if (stream) {
    await handleStreaming(req, res, prompt, options, model, abortController, circuitBreaker);
  } else {
    await handleNonStreaming(req, res, prompt, options, model, abortController, circuitBreaker);
  }
}

async function handleSessionNonStreaming(
  req: ParsedRequest,
  res: ServerResponse,
  session: import("../session.js").Session,
  prompt: string,
  model: string,
  sessionId: string,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  try {
    const result = await session.send(prompt);
    apiSessions.recordRequest(sessionId, result.cost);
    circuitBreaker?.onSuccess();
    const response = claudeResultToOpenai(result.text, model, result.usage);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Session-Id": result.sessionId || sessionId,
    });
    res.end(JSON.stringify(response));
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const code = err instanceof AgentError ? err.code : undefined;
    circuitBreaker?.onFailure(code);
    logError(req.requestId || "", e.message);
    const status = errorToHttpStatus(e);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(openaiErrorBody(status, e.message)));
  }
}

async function handleSessionStreaming(
  req: ParsedRequest,
  res: ServerResponse,
  session: import("../session.js").Session,
  prompt: string,
  model: string,
  sessionId: string,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Session-Id": sessionId,
  });

  const completionId = `chatcmpl-otterly-${crypto.randomUUID().slice(0, 12)}`;
  await sseWrite(res, sseData(makeStreamChunk(completionId, { role: "assistant" }, null, model)));

  try {
    for await (const event of session.sendStream(prompt)) {
      if (event.type === "text_delta") {
        await sseWrite(res, sseData(makeStreamChunk(completionId, { content: event.delta }, null, model)));
      } else if (event.type === "result") {
        apiSessions.recordRequest(sessionId, event.cost);
        await sseWrite(res, sseData(makeStreamChunk(completionId, {}, "stop", model)));
      }
    }
    circuitBreaker?.onSuccess();
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const code = err instanceof AgentError ? err.code : undefined;
    circuitBreaker?.onFailure(code);
    await sseWrite(res, sseData({ error: { message: e.message, type: "server_error" } }));
  }

  await sseWrite(res, "data: [DONE]\n\n");
  if (!res.writableEnded) res.end();
}

async function handleNonStreaming(
  req: ParsedRequest,
  res: ServerResponse,
  prompt: string,
  options: EngineOptions,
  model: string,
  abortController: AbortController,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const engine = new ClaudeEngine();

  try {
    const result = await engine.run(prompt, options);
    circuitBreaker?.onSuccess();
    const response = claudeResultToOpenai(result.text, model, result.usage);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name === "AbortError" || abortController.signal.aborted) return;
    const code = err instanceof AgentError ? err.code : undefined;
    circuitBreaker?.onFailure(code);
    logError(req.requestId || "", e.message);
    const status = errorToHttpStatus(e);
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openaiErrorBody(status, e.message)));
    }
  }
}

async function handleStreaming(
  req: ParsedRequest,
  res: ServerResponse,
  prompt: string,
  options: EngineOptions,
  model: string,
  abortController: AbortController,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const engine = new ClaudeEngine();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const completionId = `chatcmpl-otterly-${crypto.randomUUID().slice(0, 12)}`;

  // Send initial role chunk
  await sseWrite(res, sseData(makeStreamChunk(completionId, { role: "assistant" }, null, model)));

  // SSE keepalive heartbeats every 5s until first content arrives.
  // Without this, clients with idle-detection (e.g. OpenAI/JS SDK) abandon
  // long-running streams during Claude Code cold spawn or large-prompt processing.
  let firstContentSeen = false;
  const heartbeat = setInterval(() => {
    if (firstContentSeen || res.writableEnded) return;
    try { res.write(": keepalive\n\n"); } catch { /* ignore */ }
  }, 5000);

  try {
    for await (const event of engine.stream(prompt, options)) {
      if (event.type === "text" || event.type === "text_delta" || event.type === "result") {
        firstContentSeen = true;
        clearInterval(heartbeat);
      }
      if (abortController.signal.aborted) break;

      if (event.type === "text_delta") {
        await sseWrite(res, sseData(makeStreamChunk(completionId, { content: event.delta }, null, model)));
      } else if (event.type === "text") {
        // CLI mode emits a single `text` event with the full answer
        // (vs SDK streaming which emits text_delta). Relay it as a content chunk.
        if (event.text) {
          await sseWrite(res, sseData(makeStreamChunk(completionId, { content: event.text }, null, model)));
        }
      } else if (event.type === "result") {
        // Don't re-emit result.text — text/text_delta already covered it for both paths.
        await sseWrite(res, sseData(makeStreamChunk(completionId, {}, "stop", model)));
      }
    }
    circuitBreaker?.onSuccess();
  } catch (err) {
    clearInterval(heartbeat);
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name !== "AbortError" && !abortController.signal.aborted) {
      const code = err instanceof AgentError ? err.code : undefined;
      circuitBreaker?.onFailure(code);
      logError(req.requestId || "", e.message);
      await sseWrite(res, sseData({ error: { message: e.message, type: "server_error" } }));
    }
  }

  clearInterval(heartbeat);
  await sseWrite(res, "data: [DONE]\n\n");
  if (!res.writableEnded) {
    res.end();
  }
}

/** Write to SSE response with backpressure support. */
async function sseWrite(res: ServerResponse, data: string): Promise<void> {
  if (res.writableEnded) return;
  const ok = res.write(data);
  if (!ok) {
    await new Promise<void>((resolve) => res.once("drain", resolve));
  }
}
