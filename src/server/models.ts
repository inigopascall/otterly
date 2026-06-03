// Shared catalog of the Claude models otterly advertises through its discovery
// endpoints: OpenAI's `GET /v1/models` and Ollama's `GET /api/tags` + `/api/show`.
//
// The list is static because Claude Code's model set is fixed per release — there
// is no registry to query at runtime. Whatever a client picks from this list is
// passed through verbatim as `claude --model <id>`, so keep the ids in sync with
// what the installed `claude` CLI actually accepts.

export interface ModelInfo {
  /** Model id sent to `claude --model` and echoed back in responses. */
  id: string;
  /** Human label for display surfaces. */
  label: string;
  /** Context window in tokens, surfaced to clients that ask (e.g. Ollama /api/show). */
  contextWindow: number;
}

export const MODELS: ModelInfo[] = [
  { id: "claude-opus-4-20250514", label: "Claude Opus 4", contextWindow: 200000 },
  { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", contextWindow: 200000 },
  { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", contextWindow: 200000 },
];

export const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/** Look up catalog metadata for a model id, falling back to the default entry. */
export function findModel(id: string | undefined): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.id === DEFAULT_MODEL)!;
}
