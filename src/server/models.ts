/**
 * models.ts
 *
 * Single source of truth for the model catalog and the process-wide backend
 * selection.  Both compat modules (openai-compat, ollama-compat) import from
 * here, so making backend awareness live here keeps new coupling minimal.
 */

// ---------------------------------------------------------------------------
// Model descriptor
// ---------------------------------------------------------------------------

/** Describes one LLM model that Otterly exposes through its API surfaces. */
export interface ModelInfo {
  /** Canonical model identifier used in API requests. */
  id: string;
  /** Human-readable display name. */
  label: string;
  /** Maximum context window in tokens. */
  contextWindow: number;
}

// ---------------------------------------------------------------------------
// Claude model catalog
// ---------------------------------------------------------------------------

/**
 * The Claude model catalog.  Exported as both `MODELS` (backward-compatible
 * name used by legacy callers) and `CLAUDE_MODELS` (readable alias for new
 * code that operates alongside the Cursor catalog).
 */
export const MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8",             label: "Claude Opus 4",      contextWindow: 200000 },
  { id: "claude-sonnet-4-6",           label: "Claude Sonnet 4",    contextWindow: 200000 },
  { id: "claude-haiku-4-5-20251001",   label: "Claude Haiku 4.5",   contextWindow: 200000 },
];

/** Alias for MODELS that makes intent clear at call sites. */
export const CLAUDE_MODELS = MODELS;

/** Default model identifier for the Claude backend. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Cursor model catalog
// ---------------------------------------------------------------------------

/**
 * The Cursor model catalog — curated from `cursor-agent --list-models` on the
 * target machine. This is a representative subset (one entry per family plus
 * the useful reasoning tiers); the full CLI list also exposes every `-fast`
 * variant and finer tiers. Any valid CLI ID still works when typed directly in
 * a client — this list only drives discovery (GET /v1/models, /api/tags).
 */
export const CURSOR_MODELS: ModelInfo[] = [
  // Cursor Composer
  { id: "composer-2.5",                       label: "Cursor Composer 2.5",          contextWindow: 200000  },
  { id: "composer-2.5-fast",                  label: "Cursor Composer 2.5 Fast",     contextWindow: 200000  },
  // OpenAI GPT / Codex
  { id: "gpt-5.5-low",                        label: "GPT-5.5 Low",                  contextWindow: 1000000 },
  { id: "gpt-5.5-medium",                     label: "GPT-5.5",                      contextWindow: 1000000 },
  { id: "gpt-5.5-high",                       label: "GPT-5.5 High",                 contextWindow: 1000000 },
  { id: "gpt-5.5-extra-high",                 label: "GPT-5.5 Extra High",           contextWindow: 1000000 },
  { id: "gpt-5.4-medium",                     label: "GPT-5.4",                      contextWindow: 1000000 },
  { id: "gpt-5.4-high",                       label: "GPT-5.4 High",                 contextWindow: 1000000 },
  { id: "gpt-5.4-nano-xhigh",                 label: "GPT-5.4 Nano XHigh",           contextWindow: 1000000 },
  { id: "gpt-5.3-codex",                      label: "Codex 5.3",                    contextWindow: 1000000 },
  { id: "gpt-5.2",                            label: "GPT-5.2",                      contextWindow: 1000000 },
  { id: "gpt-5.1",                            label: "GPT-5.1",                      contextWindow: 1000000 },
  // Anthropic Claude (via Cursor)
  { id: "claude-opus-4-8-high",               label: "Claude Opus 4.8",              contextWindow: 1000000 },
  { id: "claude-opus-4-8-max",                label: "Claude Opus 4.8 Max",          contextWindow: 1000000 },
  { id: "claude-opus-4-8-thinking-high",      label: "Claude Opus 4.8 Thinking",     contextWindow: 1000000 },
  { id: "claude-4.6-sonnet-medium",           label: "Claude Sonnet 4.6",            contextWindow: 1000000 },
  { id: "claude-4.6-sonnet-medium-thinking",  label: "Claude Sonnet 4.6 Thinking",   contextWindow: 1000000 },
  { id: "claude-4.5-sonnet",                  label: "Claude Sonnet 4.5",            contextWindow: 200000  },
  { id: "claude-4-sonnet",                    label: "Claude Sonnet 4",              contextWindow: 200000  },
  // Google Gemini
  { id: "gemini-3.1-pro",                     label: "Gemini 3.1 Pro",               contextWindow: 1000000 },
  { id: "gemini-3-flash",                     label: "Gemini 3 Flash",               contextWindow: 1000000 },
  { id: "gemini-3.5-flash",                   label: "Gemini 3.5 Flash",             contextWindow: 1000000 },
  // xAI Grok
  { id: "grok-4.3",                           label: "Grok 4.3",                     contextWindow: 1000000 },
  // Moonshot Kimi
  { id: "kimi-k2.5",                          label: "Kimi K2.5",                    contextWindow: 256000  },
];

/** Default model identifier for the Cursor backend. */
export const CURSOR_DEFAULT_MODEL = "composer-2.5";

// ---------------------------------------------------------------------------
// Process-wide backend state
// ---------------------------------------------------------------------------

/** The two backends Otterly supports. */
export type Backend = "claude" | "cursor";

/** Mutable backend selection — changed once at startup via setBackend(). */
let activeBackend: Backend = "claude";

/** Sets the process-wide active backend.  Called once during server startup. */
export function setBackend(b: Backend): void {
  activeBackend = b;
}

/** Returns the currently active backend. */
export function getBackend(): Backend {
  return activeBackend;
}

// ---------------------------------------------------------------------------
// Backend-aware accessors
// ---------------------------------------------------------------------------

/** Returns the model catalog for the currently active backend. */
export function getModels(): ModelInfo[] {
  return activeBackend === "cursor" ? CURSOR_MODELS : CLAUDE_MODELS;
}

/** Returns the default model ID for the currently active backend. */
export function getDefaultModel(): string {
  return activeBackend === "cursor" ? CURSOR_DEFAULT_MODEL : DEFAULT_MODEL;
}

/**
 * Looks up a model by ID within the currently active backend's catalog.
 * Falls back to the default model entry if no match is found.
 */
export function findModel(id: string): ModelInfo {
  const catalog = getModels();
  const found = catalog.find((m) => m.id === id);
  if (found) return found;
  // Fall back to the default model for this backend.
  return catalog.find((m) => m.id === getDefaultModel()) ?? catalog[0];
}
