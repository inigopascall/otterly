// POST /v1/chat/completions — OpenAI-compatible endpoint.
// Supports streaming (SSE) and non-streaming responses.
// Auth is handled by middleware in index.ts — not checked here.

import type { ServerResponse } from "http";
import crypto from "crypto";
import { AgentError } from "../errors.js";
import { EFFORT_LEVELS } from "../engine.js";
import type { EngineOptions } from "../types.js";
import type { ParsedRequest, ServerContext } from "./routes-native.js";
import { apiSessions } from "./session-store.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { log, logError, logDiag } from "./logger.js";
import { metrics } from "./metrics.js";
import { getDefaultModel } from "./models.js";
import { makeEngine } from "./engine-factory.js";
import {
  openaiToClaudeInput,
  claudeResultToOpenai,
  makeStreamChunk,
  sseData,
  errorToHttpStatus,
  openaiErrorBody,
  buildToolInstruction,
  parseToolCalls,
  describeToolCallIntent,
  toOpenAIToolCalls,
  CLAUDE_BUILTIN_TOOLS,
  TOOL_CALL_REMINDER,
  type OpenAIChatRequest,
  type ToolCallParseDiag,
} from "./openai-compat.js";
import { repairToolCalls, looksLikeToolCallIntent } from "./tool-call-repair.js";
import { traceEnabled, traceWrite, traceDir } from "./trace.js";

/** Abort reason used when the client hangs up before the response is complete. */
const CLIENT_DISCONNECTED = "client_disconnected";

/** OpenAI reasoning_effort values the Claude CLI has no level for, mapped to its lowest level. */
const EFFORT_ALIASES = new Map<string, string>([["none", "low"], ["minimal", "low"]]);

/**
 * The TIMEOUT error behind a failure, if the failure was a timeout: either the
 * engine threw one, or the request's signal was aborted with one as its reason.
 */
function timeoutOf(err: unknown, signal: AbortSignal): AgentError | null {
  if (err instanceof AgentError && err.code === "TIMEOUT") return err;
  const reason = signal.aborted ? signal.reason : undefined;
  if (reason instanceof AgentError && reason.code === "TIMEOUT") return reason;
  return null;
}

/**
 * Answer a timed-out request: a 504 JSON error when nothing has been sent yet,
 * otherwise an SSE error chunk (the caller then writes `[DONE]` and ends).
 * Timeouts do not count against the circuit breaker: one oversized prompt must
 * not block every other request.
 */
async function respondTimeout(
  req: ParsedRequest,
  res: ServerResponse,
  startedAt: number,
  timeout: AgentError,
): Promise<void> {
  const status = 504;
  log("error", {
    requestId: req.requestId || "",
    message: "request_timeout",
    status,
    durationMs: Date.now() - startedAt,
  });
  metrics.record({
    ts: Date.now(), endpoint: "chat", status,
    durationMs: Date.now() - startedAt,
    cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
    error: "timeout",
  });
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(openaiErrorBody(status, timeout.message)));
  } else {
    await sseWrite(res, sseData({ error: { message: timeout.message, type: "timeout_error", code: status } }));
  }
}

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
  let effort: string | undefined;
  if (body.reasoning_effort !== undefined) {
    const raw: unknown = body.reasoning_effort;
    const mapped = typeof raw === "string" ? (EFFORT_ALIASES.get(raw) ?? raw) : undefined;
    if (mapped === undefined || !EFFORT_LEVELS.includes(mapped)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openaiErrorBody(400, "reasoning_effort must be one of: " + [...EFFORT_ALIASES.keys(), ...EFFORT_LEVELS].join(", "))));
      return;
    }
    effort = mapped;
  }

  const { prompt, systemPrompt, isMultimodal } = openaiToClaudeInput(body);
  const model = body.model || getDefaultModel();
  const stream = body.stream === true;

  const abortController = new AbortController();
  // A client that hangs up and a server deadline both cancel the run, and the
  // abort reason tells them apart downstream. The response's "close" event,
  // before the response has ended, is the reliable sign that the client left.
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort(CLIENT_DISCONNECTED);
  });
  if (req.timeoutSignal) {
    const deadline = req.timeoutSignal;
    const onDeadline = () => abortController.abort(deadline.reason);
    if (deadline.aborted) onDeadline();
    else deadline.addEventListener("abort", onDeadline, { once: true });
  }

  const options: EngineOptions = {
    cwd: ctx.workingDir,
    permissionMode: "bypassPermissions",
    signal: abortController.signal,
    maxTurns: 1,        // a pure chat completion is one turn; even a leaked tool can't loop
    traceId: req.requestId || "",
    timeoutMs: req.timeoutMs,
  };

  if (traceEnabled()) {
    traceWrite(req.requestId || "", "request.json", JSON.stringify(body, null, 2));
    logDiag("info", {
      requestId: req.requestId || "",
      message: "trace_dir",
      dir: traceDir(req.requestId || ""),
    });
  }

  // Default to medium effort when the client omits reasoning_effort.
  options.effort = (effort ?? "medium") as EngineOptions["effort"];

  // Build system prompt: original + JSON mode injection
  let finalSystemPrompt = systemPrompt || "";
  if (body.response_format?.type === "json_object") {
    const jsonInstruction = "You must respond with valid JSON only. No markdown, no explanation, no code fences, just a JSON object.";
    finalSystemPrompt = finalSystemPrompt
      ? `${finalSystemPrompt}\n\n${jsonInstruction}`
      : jsonInstruction;
  }

  // Function calling: when the client supplies `tools`, OpenAI semantics say the
  // CLIENT executes them. We teach Claude to emit a tool-call JSON object and
  // disable its own built-in tools so it never runs Bash/Write on the server.
  // The directive goes into the user turn (not the system prompt) because
  // Claude Code's agentic prior otherwise overrides a system-level instruction
  // and refuses ("I can't access live data") instead of emitting the call.
  const wantsTools =
    Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice !== "none";
  let enginePrompt = prompt;
  if (wantsTools) {
    const instruction = buildToolInstruction(body.tools!, body.tool_choice);
    // The reminder is repeated after the user request because the instruction
    // above it sits at the top of a prompt that can run to hundreds of thousands
    // of characters, far from where the model actually starts generating.
    enginePrompt = `${instruction}\n\n=== USER REQUEST ===\n${prompt}\n\n${TOOL_CALL_REMINDER}`;
    options.disallowedTools = CLAUDE_BUILTIN_TOOLS;
    options.clientToolCalls = true;
  } else {
    // No client tools: behave like a plain chat model. Disable Claude Code's
    // built-in tools so it cannot autonomously read/edit files or run commands
    // on the server — the OpenAI-compatible client (e.g. AiderDesk) drives all
    // tool use, and every tool call stays visible to and controlled by it.
    options.disallowedTools = CLAUDE_BUILTIN_TOOLS;
  }

  if (finalSystemPrompt) {
    options.systemPrompt = finalSystemPrompt;
  }

  if (model) {
    options.model = model;
  }

  // Session reuse via X-Session-Id header or session_id in body.
  // Skipped for function-calling turns — those clients carry their own history
  // in `messages` and expect a fresh, stateless evaluation each call.
  const sessionId = !wantsTools
    ? ((req.headers["x-session-id"] as string)
      || (body as unknown as Record<string, unknown>).session_id as string
      || null)
    : null;

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

  if (wantsTools) {
    const toolNames = (body.tools || [])
      .map((t) => t.function?.name)
      .filter((n): n is string => typeof n === "string");
    await handleFunctionCalling(req, res, enginePrompt, options, model, abortController, stream, toolNames, circuitBreaker);
    return;
  }

  // Multimodal note: image_url parts are currently flattened to a text marker
  // (see openaiToClaudeInput). Real image passthrough needs the SDK content-block
  // path and is not yet supported on the CLI spawn path.

  if (stream) {
    await handleStreaming(req, res, prompt, options, model, abortController, circuitBreaker);
  } else {
    await handleNonStreaming(req, res, prompt, options, model, abortController, circuitBreaker);
  }
}

/**
 * Function-calling path. Runs Claude to completion (buffered), parses its output
 * for a tool-call request, and returns either OpenAI `tool_calls` (finish_reason
 * "tool_calls") or a normal text answer. Buffering is required because the call
 * is detected from the full response, so even streaming clients get the result
 * emitted as a single terminal set of chunks.
 */
async function handleFunctionCalling(
  req: ParsedRequest,
  res: ServerResponse,
  prompt: string,
  options: EngineOptions,
  model: string,
  abortController: AbortController,
  stream: boolean,
  toolNames: string[],
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const engine = makeEngine();
  const startedAt = Date.now();
  const requestId = req.requestId || "";

  try {
    const result = await engine.run(prompt, options);
    // An aborted run may still return (with whatever it had). Hand it to the
    // catch below, which answers a timeout and stays silent for a disconnect.
    if (abortController.signal.aborted) throw new Error("Aborted");
    circuitBreaker?.onSuccess();

    traceWrite(requestId, "engine-text.txt", result.text);

    const diag: ToolCallParseDiag = {};
    const parsed = parseToolCalls(result.text, diag);
    let toolCalls = parsed ? toOpenAIToolCalls(parsed) : null;
    let notice: string | undefined;

    if (toolCalls) {
      logDiag("info", {
        requestId,
        message: "tool_call_parsed",
        format: diag.format || "",
        objectsScanned: diag.objectsScanned ?? 0,
        tools: toolCalls.map((tc) => tc.function.name),
        textChars: result.text.length,
      });
    }

    if (!toolCalls) {
      // The parser found nothing. Before treating the reply as prose, try a
      // strictly structural repair (see repairToolCalls): in practice the only
      // observed defect is a single missing closing bracket.
      const repaired = repairToolCalls(result.text);
      if (repaired) {
        toolCalls = toOpenAIToolCalls(repaired.calls);
        notice =
          `⚠️ Otterly repaired a malformed tool call: ${repaired.repairs.join("; ")}. ` +
          "Arguments preserved byte-for-byte.";
        log("warn", {
          requestId: req.requestId || "",
          message: "tool_call_repaired",
          repairs: repaired.repairs,
          charsAltered: repaired.charsAltered,
          tools: repaired.calls.map((c) => c.name),
        });
      } else if (looksLikeToolCallIntent(result.text, toolNames)) {
        // The model set out to call a tool — either the JSON envelope this bridge
        // asks for, or its own native <invoke name="..."> markup naming a tool the
        // request offered — and produced something we can neither parse nor safely
        // repair. Returning that as assistant text would end the client's agent
        // loop silently, so fail loudly instead and let the client's own bounded
        // retry re-sample the model.
        // Deliberately NOT circuitBreaker.onFailure(): the service is healthy;
        // the model output was not.
        const status = 502;
        traceWrite(requestId, "unparseable-tool-call.txt", result.text);
        // Terse line on the console: this is a genuine failure and should be
        // visible without tracing turned on.
        log("error", {
          requestId,
          message: "tool_call_unparseable",
          status,
          textLength: result.text.length,
        });
        // The bytes themselves go to the trace file only.
        logDiag("error", {
          requestId,
          message: "tool_call_unparseable_detail",
          status,
          textLength: result.text.length,
          rawHead: result.text.slice(0, 4000),
          rawTail: result.text.length > 4000 ? result.text.slice(-1000) : "",
          intent: describeToolCallIntent(result.text, toolNames),
          parseDiag: diag,
        });
        metrics.record({
          ts: Date.now(), endpoint: "chat", status,
          durationMs: Date.now() - startedAt,
          cost: result.cost || 0,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
          toolCalls: 0,
          error: "unparseable tool call",
        });
        if (!res.headersSent) {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(openaiErrorBody(
            status,
            "The model requested a tool in a form Otterly could not parse into OpenAI tool_calls. Nothing was executed; re-send the request.",
          )));
        } else if (!res.writableEnded) {
          res.end();
        }
        return;
      } else {
        // No tool call was found and nothing looked like an envelope, so this
        // reply is about to be returned to the client as ordinary prose. That is
        // correct for a genuine text answer and catastrophic for a leaked tool
        // call, and the two were previously indistinguishable in the log.
        traceWrite(requestId, "unparsed-prose.txt", result.text);
        logDiag("warn", {
          requestId,
          message: "tool_call_none_parsed",
          textChars: result.text.length,
          rawHead: result.text.slice(0, 4000),
          rawTail: result.text.length > 4000 ? result.text.slice(-1000) : "",
          intent: describeToolCallIntent(result.text, toolNames),
          parseDiag: diag,
          offeredTools: toolNames,
        });
      }
    }

    logDiag("info", {
      requestId,
      message: "fc_response",
      stream,
      toolCallCount: toolCalls?.length || 0,
      textChars: result.text.length,
      textHead: result.text.slice(0, 160),
      textTail: result.text.slice(-160),
    });

    metrics.record({
      ts: Date.now(), endpoint: "chat", status: 200,
      durationMs: Date.now() - startedAt,
      cost: result.cost || 0,
      inputTokens: result.usage?.input_tokens || 0,
      outputTokens: result.usage?.output_tokens || 0,
      toolCalls: toolCalls?.length || 0,
    });

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const completionId = `chatcmpl-otterly-${crypto.randomUUID().slice(0, 12)}`;
      await sseWrite(res, sseData(makeStreamChunk(completionId, { role: "assistant" }, null, model)));
      if (toolCalls) {
        if (notice) {
          await sseWrite(res, sseData(makeStreamChunk(completionId, { content: notice }, null, model)));
        }
        await sseWrite(res, sseData(makeStreamChunk(completionId, {
          tool_calls: toolCalls.map((tc, index) => ({
            index, id: tc.id, type: tc.type, function: tc.function,
          })),
        }, null, model)));
        await sseWrite(res, sseData(makeStreamChunk(completionId, {}, "tool_calls", model)));
      } else {
        if (result.text) {
          await sseWrite(res, sseData(makeStreamChunk(completionId, { content: result.text }, null, model)));
        }
        await sseWrite(res, sseData(makeStreamChunk(completionId, {}, "stop", model)));
      }
      await sseWrite(res, "data: [DONE]\n\n");
      if (!res.writableEnded) res.end();
    } else {
      const response = claudeResultToOpenai(result.text, model, result.usage, toolCalls || undefined, notice);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
  } catch (err) {
    const timeout = timeoutOf(err, abortController.signal);
    if (timeout) {
      await respondTimeout(req, res, startedAt, timeout);
      if (!res.writableEnded) {
        await sseWrite(res, "data: [DONE]\n\n");
        res.end();
      }
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name === "AbortError" || abortController.signal.aborted) return;
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
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openaiErrorBody(status, e.message)));
    } else if (!res.writableEnded) {
      res.end();
    }
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

  let sawTextDelta = false;
  try {
    for await (const event of session.sendStream(prompt)) {
      if (event.type === "text_delta") {
        sawTextDelta = true;
        await sseWrite(res, sseData(makeStreamChunk(completionId, { content: event.delta }, null, model)));
      } else if (event.type === "text") {
        if (event.text && !sawTextDelta) {
          await sseWrite(res, sseData(makeStreamChunk(completionId, { content: event.text }, null, model)));
        }
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
  const engine = makeEngine();
  const startedAt = Date.now();

  try {
    const result = await engine.run(prompt, options);
    if (abortController.signal.aborted) throw new Error("Aborted");
    circuitBreaker?.onSuccess();
    metrics.record({
      ts: Date.now(), endpoint: "chat", status: 200,
      durationMs: Date.now() - startedAt,
      cost: result.cost || 0,
      inputTokens: result.usage?.input_tokens || 0,
      outputTokens: result.usage?.output_tokens || 0,
      toolCalls: result.tools?.length || 0,
    });
    if (result.tools) for (const t of result.tools) metrics.recordToolUse(t.tool);
    traceWrite(req.requestId || "", "response-text.txt", result.text);
    logDiag("info", {
      requestId: req.requestId || "",
      message: "response_text",
      textChars: result.text.length,
      textHead: result.text.slice(0, 160),
      textTail: result.text.slice(-160),
    });
    const response = claudeResultToOpenai(result.text, model, result.usage);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  } catch (err) {
    const timeout = timeoutOf(err, abortController.signal);
    if (timeout) {
      await respondTimeout(req, res, startedAt, timeout);
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name === "AbortError" || abortController.signal.aborted) return;
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
  const engine = makeEngine();

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
  // SDK streaming (includePartialMessages) emits incremental `text_delta`
  // events AND a final consolidated `text` block with the full answer. Relaying
  // both duplicates the entire response. Track whether we streamed any delta;
  // if so, suppress the terminal `text` block. CLI mode emits no deltas, only a
  // single `text` event, so it still gets relayed.
  let sawTextDelta = false;
  const heartbeat = setInterval(() => {
    if (firstContentSeen || res.writableEnded) return;
    try { res.write(": keepalive\n\n"); } catch { /* ignore */ }
  }, 5000);

  const startedAt = Date.now();
  let toolCount = 0;
  let textEventCount = 0;
  let deltaEventCount = 0;
  let suppressedTextChars = 0;
  let resultEventChars = 0;
  let sentContent = "";
  let lastResult: { cost: number; usage?: { input_tokens?: number; output_tokens?: number } } | null = null;
  try {
    for await (const event of engine.stream(prompt, options)) {
      if (event.type === "text" || event.type === "text_delta" || event.type === "result") {
        firstContentSeen = true;
        clearInterval(heartbeat);
      }
      if (abortController.signal.aborted) break;

      if (event.type === "tool_use") {
        toolCount++;
        metrics.recordToolUse(event.tool);
      } else if (event.type === "text_delta") {
        sawTextDelta = true;
        deltaEventCount++;
        sentContent += event.delta;
        await sseWrite(res, sseData(makeStreamChunk(completionId, { content: event.delta }, null, model)));
      } else if (event.type === "text") {
        // CLI mode emits a single `text` event with the full answer (vs SDK
        // streaming which emits text_delta). Relay it ONLY if we did not already
        // stream deltas — otherwise this is the SDK's terminal consolidated
        // block and relaying it would duplicate the whole response.
        textEventCount++;
        if (event.text && !sawTextDelta) {
          sentContent += event.text;
          await sseWrite(res, sseData(makeStreamChunk(completionId, { content: event.text }, null, model)));
        } else if (event.text) {
          suppressedTextChars += event.text.length;
        }
      } else if (event.type === "result") {
        resultEventChars = event.text ? event.text.length : 0;
        lastResult = { cost: event.cost, usage: event.usage };
        // Don't re-emit result.text — text/text_delta already covered it for both paths.
        await sseWrite(res, sseData(makeStreamChunk(completionId, {}, "stop", model)));
      }
    }
    if (abortController.signal.aborted) throw new Error("Aborted");
    circuitBreaker?.onSuccess();
    traceWrite(req.requestId || "", "stream-sent.txt", sentContent);
    logDiag("info", {
      requestId: req.requestId || "",
      message: "stream_summary",
      sawTextDelta,
      textEventCount,
      deltaEventCount,
      suppressedTextChars,
      resultEventChars,
      sentChars: sentContent.length,
      sentHead: sentContent.slice(0, 160),
      sentTail: sentContent.slice(-160),
    });
    metrics.record({
      ts: Date.now(), endpoint: "chat", status: 200,
      durationMs: Date.now() - startedAt,
      cost: lastResult?.cost || 0,
      inputTokens: lastResult?.usage?.input_tokens || 0,
      outputTokens: lastResult?.usage?.output_tokens || 0,
      toolCalls: toolCount,
    });
  } catch (err) {
    clearInterval(heartbeat);
    const e = err instanceof Error ? err : new Error(String(err));
    const timeout = timeoutOf(err, abortController.signal);
    if (timeout) {
      await respondTimeout(req, res, startedAt, timeout);
    } else if (e.name !== "AbortError" && !abortController.signal.aborted) {
      const code = err instanceof AgentError ? err.code : undefined;
      circuitBreaker?.onFailure(code);
      logError(req.requestId || "", e.message);
      metrics.record({
        ts: Date.now(), endpoint: "chat", status: 500,
        durationMs: Date.now() - startedAt,
        cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: toolCount,
        error: e.message,
      });
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
  if (res.writableEnded || res.destroyed) return;
  const ok = res.write(data);
  if (!ok) {
    // Wait for the socket to drain, but stop waiting if it closes first: a
    // client that has gone away never drains, and the request would hang.
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });
  }
}
