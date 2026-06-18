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
 * The Cursor model catalog.
 * Q3: Verify these IDs against `cursor-agent --list-models` output; the list
 * below is seeded from AGENTS.md §5 and may need updating once a live CLI
 * binary is available.
 */
export const CURSOR_MODELS: ModelInfo[] = [
  { id: "composer-2.5",    label: "Cursor Composer 2.5",        contextWindow: 200000  },
  { id: "gpt-5.5",         label: "GPT-5.5",                    contextWindow: 200000  },
  { id: "gemini-2.5-pro",  label: "Gemini 2.5 Pro",             contextWindow: 1000000 },
  { id: "grok-4",          label: "Grok 4",                     contextWindow: 256000  },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4 (Cursor)", contextWindow: 200000  },
  { id: "claude-opus-4-7",   label: "Claude Opus 4 (Cursor)",   contextWindow: 200000  },
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
