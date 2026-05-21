import { describe, it, expect } from "vitest";
import {
  normalizeEvents,
  createEventContext,
  describeToolUse,
} from "../src/events.js";

describe("normalizeEvents", () => {
  it("normalizes system init messages", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "system",
        subtype: "init",
        session_id: "sess-123",
        model: "claude-sonnet-4-20250514",
        cwd: "/home/user/project",
        tools: ["Read", "Write", "Bash"],
      },
      ctx
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "system",
      sessionId: "sess-123",
      model: "claude-sonnet-4-20250514",
      cwd: "/home/user/project",
      tools: ["Read", "Write", "Bash"],
    });
    expect(ctx.sessionId).toBe("sess-123");
  });

  it("normalizes assistant text messages", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Here is the fix." }],
        },
      },
      ctx
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "text",
      text: "Here is the fix.",
    });
  });

  it("normalizes assistant tool_use messages", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "/src/index.ts" },
            },
          ],
        },
      },
      ctx
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool_use",
      id: "tool-1",
      tool: "Read",
      input: { file_path: "/src/index.ts" },
      description: "Reading file: /src/index.ts",
    });
    expect(ctx.toolNames.get("tool-1")).toBe("Read");
  });

  it("normalizes mixed assistant content (text + tool_use)", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me read that file." },
            {
              type: "tool_use",
              id: "tool-2",
              name: "Read",
              input: { file_path: "/a.ts" },
            },
          ],
        },
      },
      ctx
    );

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("text");
    expect(events[1].type).toBe("tool_use");
  });

  it("normalizes tool result messages", () => {
    const ctx = createEventContext();
    ctx.toolNames.set("tool-1", "Read");

    const events = normalizeEvents(
      {
        type: "user",
        tool_use_result: true,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "file contents here",
              is_error: false,
            },
          ],
        },
      },
      ctx
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool_result",
      toolUseId: "tool-1",
      tool: "Read",
      output: "file contents here",
      isError: false,
    });
  });

  it("normalizes tool result with array content", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "user",
        tool_use_result: true,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-x",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
            },
          ],
        },
      },
      ctx
    );

    expect(events).toHaveLength(1);
    if (events[0].type === "tool_result") {
      expect(events[0].output).toBe("line 1\nline 2");
    }
  });

  it("normalizes stream delta events", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello " },
        },
      },
      ctx
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "text_delta",
      delta: "hello ",
    });
    expect(ctx.accumulatedText).toBe("hello ");
  });

  it("accumulates stream deltas in context", () => {
    const ctx = createEventContext();
    normalizeEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello " },
        },
      },
      ctx
    );
    normalizeEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "world" },
        },
      },
      ctx
    );

    expect(ctx.accumulatedText).toBe("hello world");
  });

  it("normalizes success result", () => {
    const ctx = createEventContext();
    ctx.sessionId = "sess-123";

    const events = normalizeEvents(
      {
        type: "result",
        subtype: "success",
        result: "Task complete.",
        total_cost_usd: 0.05,
        duration_ms: 12000,
        usage: { input_tokens: 500, output_tokens: 200 },
      },
      ctx
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "result",
      text: "Task complete.",
      cost: 0.05,
      duration: 12000,
      sessionId: "sess-123",
      usage: { input_tokens: 500, output_tokens: 200 },
    });
  });

  it("normalizes error result", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "result",
        subtype: "error",
        errors: ["Something broke", "Try again"],
      },
      ctx
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toBe("Something broke\nTry again");
    }
  });

  it("returns empty array for unknown message types", () => {
    const ctx = createEventContext();
    const events = normalizeEvents({ type: "unknown_thing" }, ctx);
    expect(events).toHaveLength(0);
  });

  it("skips user messages without tool_use_result", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "user",
        message: { content: [{ type: "text", text: "hi" }] },
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("skips non-init system messages", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      { type: "system", subtype: "other" },
      ctx
    );
    expect(events).toHaveLength(0);
  });

  it("skips non-delta stream events", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text" } },
      },
      ctx
    );
    expect(events).toHaveLength(0);
  });
});

describe("describeToolUse", () => {
  it("describes Read", () => {
    expect(describeToolUse("Read", { file_path: "/a.ts" })).toBe(
      "Reading file: /a.ts"
    );
  });

  it("describes Write", () => {
    expect(describeToolUse("Write", { file_path: "/b.ts" })).toBe(
      "Writing file: /b.ts"
    );
  });

  it("describes Edit", () => {
    expect(describeToolUse("Edit", { file_path: "/c.ts" })).toBe(
      "Editing file: /c.ts"
    );
  });

  it("describes Bash with truncation", () => {
    const long = "a".repeat(200);
    const desc = describeToolUse("Bash", { command: long });
    expect(desc.length).toBeLessThan(200);
    expect(desc).toContain("...");
    // "Running command: " (17 chars) + 80 chars + "..." (3 chars) = 100
    expect(desc.length).toBe(100);
  });

  it("describes Glob", () => {
    expect(describeToolUse("Glob", { pattern: "**/*.ts" })).toBe(
      "Searching for files: **/*.ts"
    );
  });

  it("describes Grep", () => {
    expect(describeToolUse("Grep", { pattern: "TODO" })).toBe(
      "Searching content: TODO"
    );
  });

  it("describes WebFetch", () => {
    expect(describeToolUse("WebFetch", { url: "https://example.com" })).toBe(
      "Fetching: https://example.com"
    );
  });

  it("describes WebSearch", () => {
    expect(describeToolUse("WebSearch", { query: "react hooks" })).toBe(
      "Searching: react hooks"
    );
  });

  it("falls back for unknown tools", () => {
    expect(describeToolUse("CustomTool", {})).toBe("Using tool: CustomTool");
  });
});
