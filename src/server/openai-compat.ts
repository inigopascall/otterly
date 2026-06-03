// OpenAI format <-> otterly format translation.
// Pure functions, no I/O.

import crypto from "crypto";
import type { AgentResult } from "../types.js";
import { MODELS, DEFAULT_MODEL } from "./models.js";

// ── Types ──

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  /** Present on assistant turns that requested function calls. */
  tool_calls?: OpenAIToolCall[];
  /** Present on `tool` turns: the call this message answers. */
  tool_call_id?: string;
  /** Function name, set by some clients on `tool` turns. */
  name?: string;
}

export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "text" | "json_object" };
  tools?: OpenAITool[];
  tool_choice?: string | Record<string, unknown>;
}

export interface OpenAIResponseMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIResponseMessage;
    finish_reason: "stop" | "tool_calls" | "length";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: string | null;
  }>;
}

/** Claude Code's built-in tool names. When a client supplies its own OpenAI
 *  `tools`, OpenAI semantics say the *client* executes them — so we disable all
 *  of Claude's built-ins to stop it running Bash/Write/etc. on the server. */
export const CLAUDE_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit", "Bash", "BashOutput", "KillShell",
  "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit",
  "TodoWrite", "ExitPlanMode", "AskUserQuestion",
];

// ── Conversion Functions ──

/**
 * Convert OpenAI chat messages into a prompt string + systemPrompt
 * for the otterly engine. Detects multimodal content.
 */
export function openaiToClaudeInput(body: OpenAIChatRequest): {
  prompt: string;
  systemPrompt: string | null;
  isMultimodal: boolean;
} {
  const messages = body.messages || [];
  let systemPrompt: string | null = null;
  const conversationParts: string[] = [];
  let isMultimodal = false;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = typeof msg.content === "string" ? msg.content : "";
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        conversationParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        // Multimodal content: extract text parts, note image presence
        const textParts: string[] = [];
        for (const part of msg.content) {
          if (part.type === "text" && part.text) {
            textParts.push(part.text);
          } else if (part.type === "image_url") {
            isMultimodal = true;
            textParts.push("[Image provided]");
          }
        }
        conversationParts.push(textParts.join("\n"));
      }
    } else if (msg.role === "assistant") {
      // An assistant turn may be plain text or a function-call request.
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const calls = msg.tool_calls
          .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
          .join(", ");
        conversationParts.push(`[Previous assistant response]: called function(s) ${calls}`);
      } else {
        const text = typeof msg.content === "string" ? msg.content : "";
        conversationParts.push(`[Previous assistant response]: ${text}`);
      }
    } else if (msg.role === "tool") {
      // The caller executed a function we requested and is returning its output.
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      const label = msg.name ? `function ${msg.name}` : `function call ${msg.tool_call_id || ""}`.trim();
      conversationParts.push(`[Result of ${label}]: ${text}`);
    }
  }

  let prompt: string;
  if (conversationParts.length <= 1) {
    prompt = conversationParts[0] || "";
  } else {
    const context = conversationParts.slice(0, -1).join("\n\n");
    const lastMessage = conversationParts[conversationParts.length - 1];
    prompt = `Previous conversation context:\n${context}\n\n---\n\nCurrent message:\n${lastMessage}`;
  }

  return { prompt, systemPrompt, isMultimodal };
}

// ── Function calling ──
//
// otterly drives a headless `claude` that *executes* its own tools and returns
// final text — it has no native "stop and emit a tool call" mode. So when an
// OpenAI client supplies its own `tools` (which IT will execute), we get real
// function calling by instructing Claude to emit a tool-call JSON object, then
// parsing that back into OpenAI `tool_calls`. The caller's tools are disabled
// inside Claude (see CLAUDE_BUILTIN_TOOLS) so it can't run them on the server.

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Build the system-prompt addendum that teaches Claude how to request a
 * caller-executed function. `toolChoice` may force a specific function.
 */
export function buildToolInstruction(
  tools: OpenAITool[],
  toolChoice?: OpenAIChatRequest["tool_choice"],
): string {
  const defs = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    parameters: t.function.parameters || { type: "object", properties: {} },
  }));

  let forcedName: string | null = null;
  let required = false;
  if (toolChoice && typeof toolChoice === "object") {
    forcedName = (toolChoice as { function?: { name?: string } }).function?.name || null;
  } else if (toolChoice === "required") {
    // OpenAI: the model must call at least one of the provided functions.
    required = true;
  }

  return [
    "You are a function-call router. Your ONLY job is to read the user request below and decide which of these functions should be called to fulfill it:",
    JSON.stringify(defs, null, 2),
    "",
    "Output ONLY this JSON object and nothing else — no prose, no explanation, no markdown fences:",
    '{"tool_calls": [{"name": "<function name>", "arguments": {<arguments as a JSON object>}}]}',
    "",
    "Critical rules:",
    "- You are NOT answering the user's request yourself. You only emit the function call(s); a separate system runs them and returns the real result.",
    "- So NEVER reply that you lack access to data, the internet, tools, or live information — that is the function's job, not yours. Just emit the call.",
    "- Fill arguments from the user request, matching each function's JSON Schema. Output the JSON object only.",
    "- Do not invent functions that are not listed above.",
    forcedName
      ? `- You MUST call the function "${forcedName}".`
      : required
        ? "- You MUST call at least one of the listed functions. Do not reply with plain text."
        : "- Only if NONE of the listed functions could possibly help, reply with a single line of plain text instead of JSON.",
  ].join("\n");
}

/**
 * Scan a string for every top-level balanced `{...}` region, ignoring braces
 * that appear inside JSON string literals. Lets us recover the tool-call object
 * even when it is surrounded by prose, a thinking block, or a trailing note that
 * also contains braces (a naive first-`{`-to-last-`}` slice would span them and
 * produce invalid JSON).
 */
function extractJsonObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          out.push(s.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * Parse Claude's text output for a tool-call JSON object. Returns the parsed
 * calls, or null when the output is an ordinary text answer. Tolerates stray
 * code fences and surrounding prose / thinking blocks around the JSON.
 */
export function parseToolCalls(text: string): ParsedToolCall[] | null {
  if (!text) return null;
  let s = text.trim();

  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  // Try the whole string first, then every balanced {...} region within it.
  const candidates = [s, ...extractJsonObjects(s)];

  for (const candidate of candidates) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    const rawCalls = (obj as { tool_calls?: unknown })?.tool_calls;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) continue;

    const calls: ParsedToolCall[] = [];
    for (const raw of rawCalls) {
      const entry = raw as { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } };
      const name = entry.name ?? entry.function?.name;
      if (typeof name !== "string" || !name) continue;
      let args: unknown = entry.arguments ?? entry.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = { value: args };
        }
      }
      if (typeof args !== "object" || args === null) args = {};
      calls.push({ name, arguments: args as Record<string, unknown> });
    }
    if (calls.length > 0) return calls;
  }
  return null;
}

/** Convert parsed calls into OpenAI `tool_calls` with generated ids. */
export function toOpenAIToolCalls(parsed: ParsedToolCall[]): OpenAIToolCall[] {
  return parsed.map((c) => ({
    id: `call_${crypto.randomUUID().slice(0, 24).replace(/-/g, "")}`,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
  }));
}

// ── Response Builders ──

/**
 * Build a non-streaming OpenAI chat completion response. Pass `toolCalls` to
 * emit a function-call turn (content is then null and finish_reason is
 * "tool_calls", per the OpenAI spec).
 */
export function claudeResultToOpenai(
  text: string,
  model: string,
  usage?: AgentResult["usage"],
  toolCalls?: OpenAIToolCall[],
): OpenAIChatResponse {
  const id = `chatcmpl-otterly-${crypto.randomUUID().slice(0, 12)}`;
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        message: hasTools
          ? { role: "assistant", content: null, tool_calls: toolCalls }
          : { role: "assistant", content: text || "" },
        finish_reason: hasTools ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

/** Build the OpenAI `GET /v1/models` list payload from the model catalog. */
export function buildModelsList(): {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
} {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: MODELS.map((m) => ({ id: m.id, object: "model" as const, created, owned_by: "anthropic" })),
  };
}

/**
 * Build a streaming SSE chunk.
 */
export function makeStreamChunk(
  id: string,
  delta: OpenAIStreamDelta,
  finishReason: string | null,
  model: string
): OpenAIStreamChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

/**
 * Format a chunk as an SSE data line.
 */
export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Map error to HTTP status code.
 */
export function errorToHttpStatus(err: unknown): number {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("anthropic_api_key") || msg.includes("authentication") || msg.includes("not_authenticated") || msg.includes("not logged in")) {
    return 401;
  }
  if (msg.includes("rate_limit") || msg.includes("429")) return 429;
  if (msg.includes("billing") || msg.includes("402")) return 402;
  if (msg.includes("econnrefused") || msg.includes("fetch failed") || msg.includes("network")) return 502;
  if (msg.includes("abort")) return 499;
  return 500;
}

/**
 * Build an OpenAI-style error response body.
 */
export function openaiErrorBody(status: number, message: string): { error: { message: string; type: string; code: number } } {
  const typeMap: Record<number, string> = {
    401: "authentication_error",
    429: "rate_limit_error",
    402: "billing_error",
    502: "network_error",
  };
  return {
    error: {
      message,
      type: typeMap[status] || "server_error",
      code: status,
    },
  };
}
