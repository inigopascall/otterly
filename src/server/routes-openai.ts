// POST /v1/chat/completions — OpenAI-compatible endpoint.
// Supports streaming (SSE) and non-streaming responses.
// Auth is handled by middleware in index.ts — not checked here.

import type { ServerResponse } from "http";
import crypto from "crypto";
import { AgentError } from "../errors.js";
import { EFFORT_LEVELS, CliTerminatedError, getIdleTimeoutMs } from "../engine.js";
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
  toOpenAIUsage,
  type OpenAIChatRequest,
  type ToolCallParseDiag,
} from "./openai-compat.js";
import { repairToolCalls, looksLikeToolCallIntent } from "./tool-call-repair.js";
import { traceEnabled, traceWrite, traceDir } from "./trace.js";
import { SseStream, sseWrite } from "./sse-stream.js";
import { ToolCallStreamer, reconcileStreamedCalls, type StreamAction } from "./tool-call-stream.js";
import { requestFingerprint, recordDrop, retryNotice, clearDrop } from "./retry-notice.js";

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

/** A fresh OpenAI tool-call id. */
function newToolCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Input and output token counts from an engine's usage object, for metrics. */
function usageTokens(usage: unknown): { inputTokens: number; outputTokens: number } {
  const u = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
  };
}

/** How a run that failed after its SSE stream opened is answered. */
type StreamFailure =
  | { kind: "disconnected" }
  | { kind: "retry"; reason: string }
  | { kind: "timeout"; timeout: AgentError }
  | { kind: "error"; err: Error; status: number };

/**
 * Classify a failure after the response headers have gone out.
 *
 * - The client hung up: there is nobody to answer.
 * - The run went silent past the idle limit, or called one of Claude's own
 *   tools: the stream is dropped, which the client retries (see dropForRetry).
 * - The deadline passed: an in-stream timeout error. Retrying a run that used
 *   the whole deadline would only use it again.
 * - Anything else: an in-stream error.
 */
function classifyStreamFailure(err: unknown, signal: AbortSignal): StreamFailure {
  const reason = signal.aborted ? signal.reason : undefined;
  if (reason instanceof AgentError && reason.code === "TIMEOUT") return { kind: "timeout", timeout: reason };
  if (err instanceof AgentError && err.code === "TIMEOUT") {
    if (err.original instanceof CliTerminatedError && err.original.reason === "idle") {
      return { kind: "retry", reason: `produced no output for ${Math.round(getIdleTimeoutMs() / 1000)} s and was stopped` };
    }
    return { kind: "timeout", timeout: err };
  }
  if (err instanceof AgentError && err.code === "NATIVE_TOOL_CALL") {
    return { kind: "retry", reason: "called one of Claude's own tools instead of requesting an external one" };
  }
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.name === "AbortError" || signal.aborted) return { kind: "disconnected" };
  return { kind: "error", err: e, status: errorToHttpStatus(e) };
}

/**
 * Cut an open stream so that the client re-sends the request. AiderDesk, like
 * any client on the AI SDK, retries a dropped connection and discards the
 * partial reply; it does not retry an HTTP error or an in-stream error. The
 * drop is recorded so that the retry opens with a notice saying why.
 */
function dropForRetry(
  req: ParsedRequest,
  out: SseStream,
  fingerprint: string,
  reason: string,
  startedAt: number,
  detail: Record<string, unknown> = {},
): void {
  recordDrop(fingerprint, reason);
  log("warn", {
    requestId: req.requestId || "",
    message: "stream_dropped_for_retry",
    reason,
    durationMs: Date.now() - startedAt,
    ...detail,
  });
  metrics.record({
    ts: Date.now(), endpoint: "chat", status: 502,
    durationMs: Date.now() - startedAt,
    cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
    error: `dropped for retry: ${reason}`,
  });
  out.drop();
}

/** Answer a failure on an open stream as classifyStreamFailure decides. */
async function failStream(
  req: ParsedRequest,
  out: SseStream,
  err: unknown,
  signal: AbortSignal,
  fingerprint: string,
  startedAt: number,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const failure = classifyStreamFailure(err, signal);
  switch (failure.kind) {
    case "disconnected":
      out.close();
      return;
    case "retry":
      dropForRetry(req, out, fingerprint, failure.reason, startedAt);
      return;
    case "timeout":
      await respondTimeout(req, out.response, startedAt, failure.timeout);
      await out.done();
      return;
    case "error": {
      const code = err instanceof AgentError ? err.code : undefined;
      circuitBreaker?.onFailure(code);
      logError(req.requestId || "", failure.err.message);
      metrics.record({
        ts: Date.now(), endpoint: "chat", status: failure.status,
        durationMs: Date.now() - startedAt,
        cost: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
        error: failure.err.message,
      });
      await out.fail(failure.err.message, openaiErrorBody(failure.status, "").error.type, failure.status);
      return;
    }
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
  const fingerprint = requestFingerprint(body);

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
    if (stream) {
      await handleFunctionCallingStream(req, res, enginePrompt, options, model, abortController, toolNames, fingerprint, circuitBreaker);
    } else {
      await handleFunctionCalling(req, res, enginePrompt, options, model, abortController, toolNames, circuitBreaker);
    }
    return;
  }

  // Multimodal note: image_url parts are currently flattened to a text marker
  // (see openaiToClaudeInput). Real image passthrough needs the SDK content-block
  // path and is not yet supported on the CLI spawn path.

  if (stream) {
    await handleStreaming(req, res, prompt, options, model, abortController, fingerprint, circuitBreaker);
  } else {
    await handleNonStreaming(req, res, prompt, options, model, abortController, circuitBreaker);
  }
}

/**
 * Function-calling path, non-streamed. Runs Claude to completion, parses its
 * output for a tool-call request, and returns either OpenAI `tool_calls`
 * (finish_reason "tool_calls") or a normal text answer. Streamed requests go to
 * handleFunctionCallingStream.
 */
async function handleFunctionCalling(
  req: ParsedRequest,
  res: ServerResponse,
  prompt: string,
  options: EngineOptions,
  model: string,
  abortController: AbortController,
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
      stream: false,
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

    const response = claudeResultToOpenai(result.text, model, result.usage, toolCalls || undefined, notice);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
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

/**
 * Function-calling path, streamed. Thinking and prose go out as they are
 * generated; a tool call is announced as soon as its name is known and its
 * arguments follow as the model writes them (ToolCallStreamer). The finished
 * reply is then parsed exactly as in handleFunctionCalling, and that parse
 * decides the outcome: the streamed calls are confirmed and the response ends
 * with finish_reason "tool_calls"; or the reply is prose and ends with "stop";
 * or the reply shows tool-call intent that cannot be parsed, or the parse
 * disagrees with what was streamed, and the stream is dropped so that the
 * client retries.
 */
async function handleFunctionCallingStream(
  req: ParsedRequest,
  res: ServerResponse,
  prompt: string,
  options: EngineOptions,
  model: string,
  abortController: AbortController,
  toolNames: string[],
  fingerprint: string,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const engine = makeEngine();
  const requestId = req.requestId || "";
  const startedAt = Date.now();
  const out = new SseStream(res, model);
  await out.start();
  await out.thinking(retryNotice(fingerprint) ?? "");

  const streamer = new ToolCallStreamer();
  const callIds: string[] = [];
  const callId = (index: number): string => (callIds[index] ??= newToolCallId());
  const apply = async (actions: StreamAction[]): Promise<void> => {
    for (const action of actions) {
      if (action.type === "content") await out.text(action.text);
      else if (action.type === "tool_start") await out.toolStart(action.index, callId(action.index), action.name, action.args);
      else await out.toolArgs(action.index, action.text);
    }
  };

  // The reply arrives as text_delta events and is then repeated as one
  // consolidated `text` block, which is used only when no delta came first.
  let sawTextDelta = false;
  let resultText = "";
  let usage: unknown;
  let cost = 0;
  try {
    for await (const event of engine.stream(prompt, options)) {
      if (abortController.signal.aborted) break;
      if (event.type === "thinking_delta") {
        await out.thinking(event.delta);
      } else if (event.type === "text_delta") {
        sawTextDelta = true;
        await apply(streamer.push(event.delta));
      } else if (event.type === "text") {
        if (!sawTextDelta) await apply(streamer.push(event.text));
      } else if (event.type === "result") {
        resultText = event.text || "";
        usage = event.usage;
        cost = event.cost;
      }
    }
    if (abortController.signal.aborted) throw new Error("Aborted");
  } catch (err) {
    await failStream(req, out, err, abortController.signal, fingerprint, startedAt, circuitBreaker);
    return;
  }
  circuitBreaker?.onSuccess();

  // A reply that arrived only on the result line is classified here.
  if (!streamer.reply && resultText) await apply(streamer.push(resultText));
  const text = streamer.reply;
  traceWrite(requestId, "engine-text.txt", text);

  const diag: ToolCallParseDiag = {};
  const parsed = parseToolCalls(text, diag);
  const repaired = parsed ? null : repairToolCalls(text);
  const calls = parsed ?? repaired?.calls ?? null;

  const complete = async (reason: "stop" | "tool_calls", toolCalls: number): Promise<void> => {
    clearDrop(fingerprint);
    traceWrite(requestId, "stream-sent.txt", out.sentText);
    traceWrite(requestId, "stream-reasoning.txt", out.sentReasoning);
    logDiag("info", {
      requestId,
      message: "fc_response",
      stream: true,
      mode: streamer.mode,
      toolCallCount: toolCalls,
      streamedCalls: streamer.sentCalls.length,
      reasoningChars: out.sentReasoning.length,
      textChars: text.length,
      textHead: text.slice(0, 160),
      textTail: text.slice(-160),
    });
    metrics.record({
      ts: Date.now(), endpoint: "chat", status: 200,
      durationMs: Date.now() - startedAt,
      cost,
      ...usageTokens(usage),
      toolCalls,
    });
    await out.finish(reason, toOpenAIUsage(usage));
  };

  if (calls) {
    const reconciled = reconcileStreamedCalls(streamer.sentCalls, calls);
    if (!reconciled.ok) {
      traceWrite(requestId, "unparseable-tool-call.txt", text);
      dropForRetry(req, out, fingerprint, `streamed a tool call that the finished reply did not confirm (${reconciled.why})`, startedAt, {
        textLength: text.length,
      });
      return;
    }
    if (repaired) {
      log("warn", {
        requestId,
        message: "tool_call_repaired",
        repairs: repaired.repairs,
        charsAltered: repaired.charsAltered,
        tools: repaired.calls.map((c) => c.name),
      });
    } else {
      logDiag("info", {
        requestId,
        message: "tool_call_parsed",
        format: diag.format || "",
        objectsScanned: diag.objectsScanned ?? 0,
        tools: calls.map((c) => c.name),
        textChars: text.length,
      });
    }
    await apply(reconciled.fixups);
    const first = streamer.sentCalls.length;
    for (let k = 0; k < reconciled.remaining.length; k++) {
      const call = reconciled.remaining[k];
      await out.toolStart(first + k, callId(first + k), call.name, JSON.stringify(call.arguments));
    }
    await complete("tool_calls", calls.length);
    return;
  }

  if (looksLikeToolCallIntent(text, toolNames)) {
    traceWrite(requestId, "unparseable-tool-call.txt", text);
    // Terse line on the console: this is a genuine failure and should be
    // visible without tracing turned on.
    log("error", { requestId, message: "tool_call_unparseable", textLength: text.length });
    // The bytes themselves go to the trace file only.
    logDiag("error", {
      requestId,
      message: "tool_call_unparseable_detail",
      textLength: text.length,
      rawHead: text.slice(0, 4000),
      rawTail: text.length > 4000 ? text.slice(-1000) : "",
      intent: describeToolCallIntent(text, toolNames),
      parseDiag: diag,
    });
    dropForRetry(req, out, fingerprint, "requested a tool in a form Otterly could not parse into OpenAI tool_calls", startedAt, {
      textLength: text.length,
    });
    return;
  }

  // Prose. Anything held back as possible markup turned out not to be a call.
  await out.text(streamer.unsent);
  traceWrite(requestId, "unparsed-prose.txt", text);
  logDiag("warn", {
    requestId,
    message: "tool_call_none_parsed",
    textChars: text.length,
    rawHead: text.slice(0, 4000),
    rawTail: text.length > 4000 ? text.slice(-1000) : "",
    intent: describeToolCallIntent(text, toolNames),
    parseDiag: diag,
    offeredTools: toolNames,
  });
  await complete("stop", 0);
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

/**
 * Streamed answer without client tools. The model's thinking goes out as
 * `reasoning_content` and its reply as `content`, each as it is generated.
 */
async function handleStreaming(
  req: ParsedRequest,
  res: ServerResponse,
  prompt: string,
  options: EngineOptions,
  model: string,
  abortController: AbortController,
  fingerprint: string,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const engine = makeEngine();
  const requestId = req.requestId || "";
  const startedAt = Date.now();
  const out = new SseStream(res, model);
  await out.start();
  await out.thinking(retryNotice(fingerprint) ?? "");

  // The reply arrives as text_delta events and is then repeated as one
  // consolidated `text` block, which is sent only when no delta came first.
  let sawTextDelta = false;
  let textEventCount = 0;
  let deltaEventCount = 0;
  let toolCount = 0;
  let usage: unknown;
  let cost = 0;
  try {
    for await (const event of engine.stream(prompt, options)) {
      if (abortController.signal.aborted) break;
      if (event.type === "thinking_delta") {
        await out.thinking(event.delta);
      } else if (event.type === "text_delta") {
        sawTextDelta = true;
        deltaEventCount++;
        await out.text(event.delta);
      } else if (event.type === "text") {
        textEventCount++;
        if (!sawTextDelta) await out.text(event.text);
      } else if (event.type === "tool_use") {
        toolCount++;
        metrics.recordToolUse(event.tool);
      } else if (event.type === "result") {
        usage = event.usage;
        cost = event.cost;
      }
    }
    if (abortController.signal.aborted) throw new Error("Aborted");
  } catch (err) {
    await failStream(req, out, err, abortController.signal, fingerprint, startedAt, circuitBreaker);
    return;
  }

  circuitBreaker?.onSuccess();
  clearDrop(fingerprint);
  traceWrite(requestId, "stream-sent.txt", out.sentText);
  traceWrite(requestId, "stream-reasoning.txt", out.sentReasoning);
  logDiag("info", {
    requestId,
    message: "stream_summary",
    sawTextDelta,
    textEventCount,
    deltaEventCount,
    reasoningChars: out.sentReasoning.length,
    sentChars: out.sentText.length,
    sentHead: out.sentText.slice(0, 160),
    sentTail: out.sentText.slice(-160),
  });
  metrics.record({
    ts: Date.now(), endpoint: "chat", status: 200,
    durationMs: Date.now() - startedAt,
    cost,
    ...usageTokens(usage),
    toolCalls: toolCount,
  });
  await out.finish("stop", toOpenAIUsage(usage));
}