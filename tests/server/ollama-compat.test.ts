import { describe, it, expect } from "vitest";
import {
  ollamaMessagesToClaudeInput,
  buildOllamaTags,
  buildOllamaShow,
  ollamaChatResponse,
  ollamaChatChunk,
  ollamaChatFinal,
  ollamaGenerateResponse,
  ollamaGenerateChunk,
  ollamaGenerateFinal,
} from "../../src/server/ollama-compat.js";
import { MODELS, DEFAULT_MODEL } from "../../src/server/models.js";

describe("ollamaMessagesToClaudeInput", () => {
  it("extracts a single user message", () => {
    const { prompt, systemPrompt } = ollamaMessagesToClaudeInput([{ role: "user", content: "Hi" }]);
    expect(prompt).toBe("Hi");
    expect(systemPrompt).toBeNull();
  });

  it("pulls a system message into systemPrompt", () => {
    const { prompt, systemPrompt } = ollamaMessagesToClaudeInput([
      { role: "system", content: "Be terse" },
      { role: "user", content: "Hi" },
    ]);
    expect(systemPrompt).toBe("Be terse");
    expect(prompt).toBe("Hi");
  });

  it("honours a top-level system field", () => {
    const { systemPrompt } = ollamaMessagesToClaudeInput([{ role: "user", content: "Hi" }], "Top system");
    expect(systemPrompt).toBe("Top system");
  });

  it("frames multi-turn history as context + current message", () => {
    const { prompt } = ollamaMessagesToClaudeInput([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]);
    expect(prompt).toContain("Previous conversation context:");
    expect(prompt).toContain("[Previous assistant response]: answer");
    expect(prompt).toContain("Current message:\nsecond");
  });

  it("notes image presence and tool results", () => {
    const { prompt } = ollamaMessagesToClaudeInput([
      { role: "tool", content: "tool output" },
      { role: "user", content: "look", images: ["base64data"] },
    ]);
    expect(prompt).toContain("[Tool result]: tool output");
    expect(prompt).toContain("[Image provided]");
  });
});

describe("buildOllamaTags", () => {
  it("lists every catalog model with discovery fields tools rely on", () => {
    const { models } = buildOllamaTags();
    expect(models).toHaveLength(MODELS.length);
    const first = models[0] as Record<string, any>;
    // Tools read `name`/`model` to populate their model picker.
    expect(first.name).toBe(MODELS[0].id);
    expect(first.model).toBe(MODELS[0].id);
    // Ollama reports a bare 64-char hex digest (no "sha256:" prefix).
    expect(String(first.digest)).toMatch(/^[a-f0-9]{64}$/);
    expect(first.details.family).toBe("claude");
  });
});

describe("buildOllamaShow", () => {
  it("reports the model's context length and capabilities", () => {
    const show = buildOllamaShow(DEFAULT_MODEL) as Record<string, any>;
    const ctx = MODELS.find((m) => m.id === DEFAULT_MODEL)!.contextWindow;
    expect(show.model_info["claude.context_length"]).toBe(ctx);
    expect(show.capabilities).toContain("tools");
    expect(show.capabilities).toContain("completion");
  });

  it("falls back to the default model for an unknown id", () => {
    const show = buildOllamaShow("does-not-exist") as Record<string, any>;
    expect(show.model_info["general.architecture"]).toBe("claude");
  });
});

describe("ollama chat builders", () => {
  it("non-stream response is done with an assistant message", () => {
    const r = ollamaChatResponse("m", "hello", { promptTokens: 3, outputTokens: 4, totalMs: 10 }) as Record<string, any>;
    expect(r.done).toBe(true);
    expect(r.done_reason).toBe("stop");
    expect(r.message).toEqual({ role: "assistant", content: "hello" });
    expect(r.prompt_eval_count).toBe(3);
    expect(r.eval_count).toBe(4);
    expect(r.total_duration).toBe(10_000_000); // ms → ns
  });

  it("stream chunk is not done and carries content", () => {
    const c = ollamaChatChunk("m", "tok") as Record<string, any>;
    expect(c.done).toBe(false);
    expect(c.message.content).toBe("tok");
  });

  it("stream final is done with empty content", () => {
    const f = ollamaChatFinal("m", { outputTokens: 7 }) as Record<string, any>;
    expect(f.done).toBe(true);
    expect(f.message.content).toBe("");
    expect(f.eval_count).toBe(7);
  });

  it("defaults the model when none supplied", () => {
    const c = ollamaChatChunk("", "x") as Record<string, any>;
    expect(c.model).toBe(DEFAULT_MODEL);
  });
});

describe("ollama generate builders", () => {
  it("uses the `response` field, not `message`", () => {
    const r = ollamaGenerateResponse("m", "full text", { outputTokens: 2 }) as Record<string, any>;
    expect(r.response).toBe("full text");
    expect(r.message).toBeUndefined();
    expect(r.done).toBe(true);
  });

  it("stream chunk + final use the response field", () => {
    expect((ollamaGenerateChunk("m", "tok") as Record<string, any>).response).toBe("tok");
    const f = ollamaGenerateFinal("m") as Record<string, any>;
    expect(f.done).toBe(true);
    expect(f.response).toBe("");
  });
});
