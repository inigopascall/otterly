/**
 * models.ts
 *
 * Single source of truth for the model catalog. Both compat modules
 * (openai-compat, ollama-compat) import from here.
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

/** The Claude model catalog. `CLAUDE_MODELS` is an alias of `MODELS`. */
export const MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8",             label: "Claude Opus 4",      contextWindow: 200000 },
  { id: "claude-sonnet-4-6",           label: "Claude Sonnet 4",    contextWindow: 200000 },
  { id: "claude-haiku-4-5-20251001",   label: "Claude Haiku 4.5",   contextWindow: 200000 },
];

/** Alias for MODELS that makes intent clear at call sites. */
export const CLAUDE_MODELS = MODELS;

/** Default model identifier. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** Returns the model catalog. */
export function getModels(): ModelInfo[] {
  return MODELS;
}

/** Returns the default model ID. */
export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}

/**
 * Looks up a model by ID in the catalog.
 * Falls back to the default model entry if no match is found.
 */
export function findModel(id: string): ModelInfo {
  const catalog = getModels();
  const found = catalog.find((m) => m.id === id);
  if (found) return found;
  return catalog.find((m) => m.id === getDefaultModel()) ?? catalog[0];
}
