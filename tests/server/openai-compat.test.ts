import { describe, it, expect } from "vitest";
import {
  openaiToClaudeInput,
  claudeResultToOpenai,
  makeStreamChunk,
  sseData,
  errorToHttpStatus,
  openaiErrorBody,
} from "../../src/server/openai-compat.js";

describe("openai-compat", () => {
  describe("openaiToClaudeInput", () => {
    it("extracts single user message as prompt", () => {
      const result = openaiToClaudeInput({
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(result.prompt).toBe("Hello");
      expect(result.systemPrompt).toBeNull();
    });

    it("extracts system message as systemPrompt", () => {
      const result = openaiToClaudeInput({
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Hello" },
        ],
      });
      expect(result.prompt).toBe("Hello");
      expect(result.systemPrompt).toBe("Be concise");
    });

    it("uses last system message", () => {
      const result = openaiToClaudeInput({
        messages: [
          { role: "system", content: "First" },
          { role: "system", content: "Second" },
          { role: "user", content: "Hello" },
        ],
      });
      expect(result.systemPrompt).toBe("Second");
    });

    it("combines multi-turn into context + current message", () => {
      const result = openaiToClaudeInput({
        messages: [
          { role: "user", content: "Fix the bug" },
          { role: "assistant", content: "I fixed it" },
          { role: "user", content: "Now add tests" },
        ],
      });
      expect(result.prompt).toContain("Previous conversation context:");
      expect(result.prompt).toContain("Fix the bug");
      expect(result.prompt).toContain("[Previous assistant response]: I fixed it");
      expect(result.prompt).toContain("Current message:\nNow add tests");
    });

    it("handles empty messages array", () => {
      const result = openaiToClaudeInput({ messages: [] });
      expect(result.prompt).toBe("");
      expect(result.systemPrompt).toBeNull();
    });

    it("handles missing messages", () => {
      const result = openaiToClaudeInput({} as any);
      expect(result.prompt).toBe("");
    });
  });

  describe("claudeResultToOpenai", () => {
    it("builds a valid OpenAI response", () => {
      const response = claudeResultToOpenai("Hello world", "claude-sonnet-4-20250514");
      expect(response.object).toBe("chat.completion");
      expect(response.id).toMatch(/^chatcmpl-otterly-/);
      expect(response.choices).toHaveLength(1);
      expect(response.choices[0].message.role).toBe("assistant");
      expect(response.choices[0].message.content).toBe("Hello world");
      expect(response.choices[0].finish_reason).toBe("stop");
      expect(response.model).toBe("claude-sonnet-4-20250514");
    });

    it("includes usage when provided", () => {
      const response = claudeResultToOpenai("Hi", "m", { input_tokens: 100, output_tokens: 50 });
      expect(response.usage.prompt_tokens).toBe(100);
      expect(response.usage.completion_tokens).toBe(50);
      expect(response.usage.total_tokens).toBe(150);
    });

    it("defaults usage to zero", () => {
      const response = claudeResultToOpenai("Hi", "m");
      expect(response.usage.total_tokens).toBe(0);
    });

    it("handles empty text", () => {
      const response = claudeResultToOpenai("", "m");
      expect(response.choices[0].message.content).toBe("");
    });
  });

  describe("makeStreamChunk", () => {
    it("builds a valid stream chunk", () => {
      const chunk = makeStreamChunk("id-1", { content: "hello" }, null, "m");
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.id).toBe("id-1");
      expect(chunk.choices[0].delta.content).toBe("hello");
      expect(chunk.choices[0].finish_reason).toBeNull();
    });

    it("sets finish_reason on final chunk", () => {
      const chunk = makeStreamChunk("id-1", {}, "stop", "m");
      expect(chunk.choices[0].finish_reason).toBe("stop");
    });

    it("includes role delta", () => {
      const chunk = makeStreamChunk("id-1", { role: "assistant" }, null, "m");
      expect(chunk.choices[0].delta.role).toBe("assistant");
    });
  });

  describe("sseData", () => {
    it("formats as SSE data line", () => {
      const result = sseData({ foo: "bar" });
      expect(result).toBe('data: {"foo":"bar"}\n\n');
    });
  });

  describe("errorToHttpStatus", () => {
    it("maps auth errors to 401", () => {
      expect(errorToHttpStatus(new Error("ANTHROPIC_API_KEY not set"))).toBe(401);
      expect(errorToHttpStatus(new Error("authentication failed"))).toBe(401);
      expect(errorToHttpStatus(new Error("not logged in"))).toBe(401);
    });

    it("maps rate limit to 429", () => {
      expect(errorToHttpStatus(new Error("rate_limit exceeded"))).toBe(429);
      expect(errorToHttpStatus(new Error("429 too many requests"))).toBe(429);
    });

    it("maps billing to 402", () => {
      expect(errorToHttpStatus(new Error("billing issue"))).toBe(402);
      expect(errorToHttpStatus(new Error("402 payment required"))).toBe(402);
    });

    it("maps network errors to 502", () => {
      expect(errorToHttpStatus(new Error("ECONNREFUSED"))).toBe(502);
      expect(errorToHttpStatus(new Error("fetch failed"))).toBe(502);
    });

    it("maps abort to 499", () => {
      expect(errorToHttpStatus(new Error("aborted"))).toBe(499);
    });

    it("defaults to 500", () => {
      expect(errorToHttpStatus(new Error("something unexpected"))).toBe(500);
    });

    it("handles non-Error input", () => {
      expect(errorToHttpStatus("rate_limit")).toBe(429);
      expect(errorToHttpStatus(42)).toBe(500);
    });
  });

  describe("openaiErrorBody", () => {
    it("builds error body with correct type", () => {
      expect(openaiErrorBody(401, "bad key").error.type).toBe("authentication_error");
      expect(openaiErrorBody(429, "slow down").error.type).toBe("rate_limit_error");
      expect(openaiErrorBody(500, "oops").error.type).toBe("server_error");
    });

    it("includes message and code", () => {
      const body = openaiErrorBody(401, "Invalid API key");
      expect(body.error.message).toBe("Invalid API key");
      expect(body.error.code).toBe(401);
    });
  });
});
