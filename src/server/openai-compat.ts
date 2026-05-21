// OpenAI format <-> otterly format translation.
// Pure functions, no I/O.

import crypto from "crypto";
import type { AgentResult } from "../types.js";

// ── Types ──

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentPart[];
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

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

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
      const text = typeof msg.content === "string" ? msg.content : "";
      conversationParts.push(`[Previous assistant response]: ${text}`);
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

/**
 * Map OpenAI tools parameter to Claude Code allowedTools names.
 * Level 1: treat tool function names as direct Claude Code tool name filters.
 */
export function openaiToolsToAllowedTools(tools: OpenAITool[]): string[] {
  // Known Claude Code tool names
  const KNOWN_TOOLS = new Set([
    "Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep",
    "WebFetch", "WebSearch", "Task", "NotebookEdit", "AskUserQuestion",
  ]);

  const allowed: string[] = [];
  for (const tool of tools) {
    const name = tool.function?.name;
    if (name && KNOWN_TOOLS.has(name)) {
      allowed.push(name);
    }
  }
  return allowed;
}

// ── Response Builders ──

/**
 * Build a non-streaming OpenAI chat completion response.
 */
export function claudeResultToOpenai(text: string, model: string, usage?: AgentResult["usage"]): OpenAIChatResponse {
  const id = `chatcmpl-otterly-${crypto.randomUUID().slice(0, 12)}`;
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "claude-sonnet-4-20250514",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text || "" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

/**
 * Build a streaming SSE chunk.
 */
export function makeStreamChunk(
  id: string,
  delta: { role?: string; content?: string },
  finishReason: string | null,
  model: string
): OpenAIStreamChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "claude-sonnet-4-20250514",
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
