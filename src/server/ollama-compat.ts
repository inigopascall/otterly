// Ollama-native format <-> otterly format translation.
// Pure functions, no I/O. Mirrors the shapes Ollama's own API returns so that
// Ollama-only tools (Open WebUI's native connection, Raycast, oterm, homelab
// dashboards) can auto-discover otterly and talk to it unchanged.
//
// Reference: https://github.com/ollama/ollama/blob/main/docs/api.md

import crypto from "crypto";
import { MODELS, DEFAULT_MODEL, findModel } from "./models.js";

// Version we report from GET /api/version. Some clients gate features on a
// minimum Ollama version, so we advertise a recent one.
export const OLLAMA_COMPAT_VERSION = "0.6.8";

// A fixed timestamp for model "modified_at" — our models don't change on disk.
const MODELS_MODIFIED_AT = "2026-05-16T00:00:00.000Z";

// ── Types ──

export interface OllamaMessage {
  role: string; // system | user | assistant | tool
  content: string;
  images?: string[];
}

export interface OllamaChatRequest {
  model?: string;
  messages?: OllamaMessage[];
  stream?: boolean;
  system?: string;
  options?: Record<string, unknown>;
}

export interface OllamaGenerateRequest {
  model?: string;
  prompt?: string;
  system?: string;
  stream?: boolean;
  options?: Record<string, unknown>;
}

// ── Converters ──

/**
 * Flatten Ollama chat messages into a single prompt + system prompt for the
 * engine. Uses the same multi-turn framing as the OpenAI path for consistency.
 */
export function ollamaMessagesToClaudeInput(
  messages: OllamaMessage[],
  topLevelSystem?: string,
): { prompt: string; systemPrompt: string | null } {
  let systemPrompt: string | null = topLevelSystem || null;
  const parts: string[] = [];

  for (const msg of messages || []) {
    if (msg.role === "system") {
      systemPrompt = msg.content || "";
    } else if (msg.role === "assistant") {
      parts.push(`[Previous assistant response]: ${msg.content || ""}`);
    } else if (msg.role === "tool") {
      parts.push(`[Tool result]: ${msg.content || ""}`);
    } else {
      // user (and any unknown role) → plain content
      let content = msg.content || "";
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        content += "\n[Image provided]";
      }
      parts.push(content);
    }
  }

  let prompt: string;
  if (parts.length <= 1) {
    prompt = parts[0] || "";
  } else {
    const context = parts.slice(0, -1).join("\n\n");
    const last = parts[parts.length - 1];
    prompt = `Previous conversation context:\n${context}\n\n---\n\nCurrent message:\n${last}`;
  }

  return { prompt, systemPrompt };
}

// ── Helpers ──

function nowIso(): string {
  return new Date().toISOString();
}

/** Stable digest so tools that key off it stay consistent across calls. Ollama
 *  reports a bare 64-char hex string here (no "sha256:" prefix). */
function digestFor(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex");
}

function msToNs(ms: number): number {
  return Math.round(ms * 1e6);
}

// ── Response Builders ──

/** GET /api/tags — the model list tools poll on startup to auto-discover us. */
export function buildOllamaTags(): {
  models: Array<Record<string, unknown>>;
} {
  return {
    models: MODELS.map((m) => ({
      name: m.id,
      model: m.id,
      modified_at: MODELS_MODIFIED_AT,
      size: 0,
      digest: digestFor(m.id),
      details: {
        parent_model: "",
        format: "api",
        family: "claude",
        families: ["claude"],
        parameter_size: "",
        quantization_level: "",
      },
    })),
  };
}

/** POST /api/show — model metadata (context length, capabilities). */
export function buildOllamaShow(modelId: string | undefined): Record<string, unknown> {
  const m = findModel(modelId);
  return {
    license: "",
    modelfile: "",
    parameters: "",
    template: "",
    details: {
      parent_model: "",
      format: "api",
      family: "claude",
      families: ["claude"],
      parameter_size: "",
      quantization_level: "",
    },
    model_info: {
      "general.architecture": "claude",
      "general.parameter_count": 0,
      "claude.context_length": m.contextWindow,
    },
    capabilities: ["completion", "tools"],
  };
}

interface FinalStats {
  promptTokens?: number;
  outputTokens?: number;
  totalMs?: number;
}

/** POST /api/chat (non-streaming) terminal response. */
export function ollamaChatResponse(model: string, content: string, stats: FinalStats = {}): Record<string, unknown> {
  return {
    model: model || DEFAULT_MODEL,
    created_at: nowIso(),
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
    total_duration: msToNs(stats.totalMs || 0),
    load_duration: 0,
    prompt_eval_count: stats.promptTokens || 0,
    prompt_eval_duration: 0,
    eval_count: stats.outputTokens || 0,
    eval_duration: 0,
  };
}

/** POST /api/chat (streaming) intermediate content chunk. */
export function ollamaChatChunk(model: string, content: string): Record<string, unknown> {
  return {
    model: model || DEFAULT_MODEL,
    created_at: nowIso(),
    message: { role: "assistant", content },
    done: false,
  };
}

/** POST /api/chat (streaming) terminal chunk with stats. */
export function ollamaChatFinal(model: string, stats: FinalStats = {}): Record<string, unknown> {
  return {
    model: model || DEFAULT_MODEL,
    created_at: nowIso(),
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    total_duration: msToNs(stats.totalMs || 0),
    load_duration: 0,
    prompt_eval_count: stats.promptTokens || 0,
    prompt_eval_duration: 0,
    eval_count: stats.outputTokens || 0,
    eval_duration: 0,
  };
}

/** POST /api/generate (non-streaming) terminal response. */
export function ollamaGenerateResponse(model: string, response: string, stats: FinalStats = {}): Record<string, unknown> {
  return {
    model: model || DEFAULT_MODEL,
    created_at: nowIso(),
    response,
    done: true,
    done_reason: "stop",
    context: [],
    total_duration: msToNs(stats.totalMs || 0),
    load_duration: 0,
    prompt_eval_count: stats.promptTokens || 0,
    prompt_eval_duration: 0,
    eval_count: stats.outputTokens || 0,
    eval_duration: 0,
  };
}

/** POST /api/generate (streaming) intermediate chunk. */
export function ollamaGenerateChunk(model: string, response: string): Record<string, unknown> {
  return {
    model: model || DEFAULT_MODEL,
    created_at: nowIso(),
    response,
    done: false,
  };
}

/** POST /api/generate (streaming) terminal chunk. */
export function ollamaGenerateFinal(model: string, stats: FinalStats = {}): Record<string, unknown> {
  return {
    model: model || DEFAULT_MODEL,
    created_at: nowIso(),
    response: "",
    done: true,
    done_reason: "stop",
    context: [],
    total_duration: msToNs(stats.totalMs || 0),
    load_duration: 0,
    prompt_eval_count: stats.promptTokens || 0,
    prompt_eval_duration: 0,
    eval_count: stats.outputTokens || 0,
    eval_duration: 0,
  };
}
