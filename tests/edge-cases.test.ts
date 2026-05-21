import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import { AgentError } from "../src/errors.js";
import {
  normalizeEvents,
  createEventContext,
  describeToolUse,
} from "../src/events.js";
import { wrapPermissionHandler, READONLY, AUTOPILOT } from "../src/permissions.js";
import { classifyError } from "../src/errors.js";

// ═══════════════════════════════════════════════════════
// EVENTS: Malformed & edge-case SDK messages
// ═══════════════════════════════════════════════════════

describe("events: malformed SDK messages", () => {
  it("handles completely empty object", () => {
    const ctx = createEventContext();
    expect(normalizeEvents({}, ctx)).toEqual([]);
  });

  it("handles null type", () => {
    const ctx = createEventContext();
    expect(normalizeEvents({ type: null }, ctx)).toEqual([]);
  });

  it("handles undefined type", () => {
    const ctx = createEventContext();
    expect(normalizeEvents({ type: undefined }, ctx)).toEqual([]);
  });

  it("handles numeric type (wrong type)", () => {
    const ctx = createEventContext();
    expect(normalizeEvents({ type: 42 }, ctx)).toEqual([]);
  });

  it("handles assistant with no message field", () => {
    const ctx = createEventContext();
    const events = normalizeEvents({ type: "assistant" }, ctx);
    expect(events).toEqual([]);
  });

  it("handles assistant with null content", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      { type: "assistant", message: { content: null } },
      ctx
    );
    expect(events).toEqual([]);
  });

  it("handles assistant with empty content array", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      { type: "assistant", message: { content: [] } },
      ctx
    );
    expect(events).toEqual([]);
  });

  it("handles assistant with unknown block type", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "hmm..." }],
        },
      },
      ctx
    );
    // Unknown block types should be silently skipped
    expect(events).toEqual([]);
  });

  it("handles tool_use with missing input", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Read" }],
        },
      },
      ctx
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_use");
    if (events[0].type === "tool_use") {
      expect(events[0].input).toEqual({});
    }
  });

  it("handles tool_result with null content", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "user",
        tool_use_result: true,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: null },
          ],
        },
      },
      ctx
    );
    expect(events).toHaveLength(1);
    if (events[0].type === "tool_result") {
      expect(events[0].output).toBe("null");
    }
  });

  it("handles tool_result with undefined content", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "user",
        tool_use_result: true,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: undefined },
          ],
        },
      },
      ctx
    );
    expect(events).toHaveLength(1);
  });

  it("handles tool_result with numeric content", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "user",
        tool_use_result: true,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: 42 },
          ],
        },
      },
      ctx
    );
    expect(events).toHaveLength(1);
    if (events[0].type === "tool_result") {
      expect(events[0].output).toBe("42");
    }
  });

  it("handles tool_result with object content (non-array, non-string)", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "user",
        tool_use_result: true,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: { key: "value" },
            },
          ],
        },
      },
      ctx
    );
    expect(events).toHaveLength(1);
    if (events[0].type === "tool_result") {
      expect(events[0].output).toBe('{"key":"value"}');
    }
  });

  it("handles tool_result with boolean content", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "user",
        tool_use_result: true,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: true },
          ],
        },
      },
      ctx
    );
    if (events[0].type === "tool_result") {
      expect(events[0].output).toBe("true");
    }
  });

  it("handles stream_event with missing event field", () => {
    const ctx = createEventContext();
    const events = normalizeEvents({ type: "stream_event" }, ctx);
    expect(events).toEqual([]);
  });

  it("handles stream_event with null event", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      { type: "stream_event", event: null },
      ctx
    );
    expect(events).toEqual([]);
  });

  it("handles stream_event delta with missing text", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta" }, // no text field
        },
      },
      ctx
    );
    expect(events).toHaveLength(1);
    if (events[0].type === "text_delta") {
      expect(events[0].delta).toBeUndefined();
    }
  });

  it("handles stream_event with input_json_delta (not text)", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"key":' },
        },
      },
      ctx
    );
    // input_json_delta is not text — should be skipped
    expect(events).toEqual([]);
  });

  it("handles result with no subtype", () => {
    const ctx = createEventContext();
    const events = normalizeEvents({ type: "result" }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toContain("Stopped: undefined");
    }
  });

  it("handles result with empty errors array", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      { type: "result", subtype: "error", errors: [] },
      ctx
    );
    expect(events).toHaveLength(1);
    if (events[0].type === "error") {
      // Empty array joined = empty string
      expect(events[0].error.message).toBe("");
    }
  });

  it("handles result success with zero cost", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      {
        type: "result",
        subtype: "success",
        result: "",
        total_cost_usd: 0,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      ctx
    );
    expect(events).toHaveLength(1);
    if (events[0].type === "result") {
      expect(events[0].cost).toBe(0);
      expect(events[0].text).toBe("");
    }
  });

  it("handles result success with missing usage", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      { type: "result", subtype: "success", result: "done" },
      ctx
    );
    if (events[0].type === "result") {
      expect(events[0].usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    }
  });

  it("handles system init with missing fields gracefully", () => {
    const ctx = createEventContext();
    const events = normalizeEvents(
      { type: "system", subtype: "init", session_id: "s1" },
      ctx
    );
    if (events[0].type === "system") {
      expect(events[0].model).toBe("");
      expect(events[0].cwd).toBe("");
      expect(events[0].tools).toEqual([]);
    }
  });
});

describe("events: tool description edge cases", () => {
  it("handles missing file_path", () => {
    expect(describeToolUse("Read", {})).toBe("Reading file: unknown");
    expect(describeToolUse("Write", {})).toBe("Writing file: unknown");
    expect(describeToolUse("Edit", {})).toBe("Editing file: unknown");
  });

  it("handles empty command", () => {
    expect(describeToolUse("Bash", {})).toBe("Running command: ");
    expect(describeToolUse("Bash", { command: "" })).toBe("Running command: ");
  });

  it("handles exactly 80-char command (no truncation)", () => {
    const cmd = "a".repeat(80);
    const desc = describeToolUse("Bash", { command: cmd });
    expect(desc).toBe(`Running command: ${cmd}`);
    expect(desc).not.toContain("...");
  });

  it("handles 81-char command (truncation boundary)", () => {
    const cmd = "a".repeat(81);
    const desc = describeToolUse("Bash", { command: cmd });
    expect(desc).toContain("...");
  });

  it("handles non-string command value", () => {
    // input.command could be a number or object in theory
    const desc = describeToolUse("Bash", { command: 42 });
    expect(desc).toBe("Running command: 42");
  });

  it("handles MultiEdit", () => {
    expect(describeToolUse("MultiEdit", { file_path: "/x.ts" })).toBe(
      "Editing file: /x.ts"
    );
  });

  it("handles NotebookEdit", () => {
    expect(describeToolUse("NotebookEdit", { notebook_path: "/nb.ipynb" })).toBe(
      "Editing notebook: /nb.ipynb"
    );
  });

  it("handles MCP tool names (namespaced)", () => {
    expect(describeToolUse("mcp__github__create_issue", { title: "bug" })).toBe(
      "Using tool: mcp__github__create_issue"
    );
  });
});

// ═══════════════════════════════════════════════════════
// ERRORS: classification edge cases
// ═══════════════════════════════════════════════════════

describe("errors: classification edge cases", () => {
  it("handles empty string error", () => {
    const err = classifyError("");
    expect(err.code).toBe("UNKNOWN");
  });

  it("handles null error", () => {
    const err = classifyError(null);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe("UNKNOWN");
  });

  it("handles undefined error", () => {
    const err = classifyError(undefined);
    expect(err).toBeInstanceOf(AgentError);
  });

  it("handles number error", () => {
    const err = classifyError(429);
    expect(err.code).toBe("RATE_LIMITED"); // "429" in string
  });

  it("handles object error (non-Error)", () => {
    const err = classifyError({ status: 429 });
    expect(err).toBeInstanceOf(AgentError);
  });

  it("handles error with both rate_limit and billing keywords", () => {
    const err = classifyError(new Error("rate_limit on billing account"));
    // rate_limit check comes first
    expect(err.code).toBe("RATE_LIMITED");
  });

  it("handles error with 'aborted' in message but not AbortError name", () => {
    const err = classifyError(new Error("The request was aborted"));
    expect(err.code).toBe("ABORTED");
  });

  it("preserves stack trace in original error", () => {
    const original = new Error("rate_limit");
    original.stack = "Error: rate_limit\n    at test.ts:1:1";
    const err = classifyError(original);
    expect(err.original?.stack).toContain("test.ts");
  });

  it("AgentError has correct name property", () => {
    const err = new AgentError("UNKNOWN", "test");
    expect(err.name).toBe("AgentError");
    expect(err instanceof Error).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// PERMISSIONS: edge cases
// ═══════════════════════════════════════════════════════

describe("permissions: READONLY preset coverage", () => {
  it("allows Read", () => {
    expect(READONLY({ tool: "Read", input: {} })).toEqual({ allow: true });
  });

  it("allows Glob", () => {
    expect(READONLY({ tool: "Glob", input: {} })).toEqual({ allow: true });
  });

  it("allows Grep", () => {
    expect(READONLY({ tool: "Grep", input: {} })).toEqual({ allow: true });
  });

  it("allows WebFetch", () => {
    expect(READONLY({ tool: "WebFetch", input: {} })).toEqual({ allow: true });
  });

  it("allows WebSearch", () => {
    expect(READONLY({ tool: "WebSearch", input: {} })).toEqual({ allow: true });
  });

  it("allows Task", () => {
    expect(READONLY({ tool: "Task", input: {} })).toEqual({ allow: true });
  });

  it("allows AskUserQuestion", () => {
    expect(READONLY({ tool: "AskUserQuestion", input: {} })).toEqual({ allow: true });
  });

  it("denies Write", () => {
    const result = READONLY({ tool: "Write", input: {} });
    expect(result.allow).toBe(false);
    expect(result.message).toContain("Write");
  });

  it("denies Edit", () => {
    expect(READONLY({ tool: "Edit", input: {} }).allow).toBe(false);
  });

  it("denies Bash", () => {
    expect(READONLY({ tool: "Bash", input: {} }).allow).toBe(false);
  });

  it("denies NotebookEdit", () => {
    expect(READONLY({ tool: "NotebookEdit", input: {} }).allow).toBe(false);
  });

  it("denies unknown tools", () => {
    expect(READONLY({ tool: "mcp__danger__delete_all", input: {} }).allow).toBe(false);
  });
});

describe("permissions: wrapPermissionHandler", () => {
  it("wraps async handler correctly", async () => {
    const handler = async ({ tool }: any) => {
      await new Promise((r) => setTimeout(r, 1));
      return { allow: tool === "Read" };
    };

    const wrapped = wrapPermissionHandler(handler);

    const allowResult = await wrapped("Read", {}, {});
    expect(allowResult.behavior).toBe("allow");

    const denyResult = await wrapped("Bash", {}, {});
    expect(denyResult.behavior).toBe("deny");
  });

  it("passes reason from SDK options", async () => {
    let capturedReason: string | undefined;
    const handler = ({ reason }: any) => {
      capturedReason = reason;
      return { allow: true };
    };

    const wrapped = wrapPermissionHandler(handler);
    await wrapped("Read", {}, { decisionReason: "Needs to read config" });
    expect(capturedReason).toBe("Needs to read config");
  });

  it("handles handler that returns updatedInput", async () => {
    const handler = () => ({
      allow: true,
      updatedInput: { file_path: "/sanitized.ts" },
    });

    const wrapped = wrapPermissionHandler(handler);
    const result = await wrapped("Read", { file_path: "/original.ts" }, {});
    expect(result.updatedInput).toEqual({ file_path: "/sanitized.ts" });
  });

  it("returns original input when handler allows without updatedInput", async () => {
    const handler = () => ({ allow: true });
    const wrapped = wrapPermissionHandler(handler);
    const original = { file_path: "/test.ts" };
    const result = await wrapped("Read", original, {});
    expect(result.updatedInput).toBe(original);
  });

  it("provides default deny message", async () => {
    const handler = () => ({ allow: false });
    const wrapped = wrapPermissionHandler(handler);
    const result = await wrapped("Bash", {}, {});
    expect(result.message).toBe("Denied by permission handler");
  });

  it("uses custom deny message", async () => {
    const handler = () => ({ allow: false, message: "Not in this house" });
    const wrapped = wrapPermissionHandler(handler);
    const result = await wrapped("Bash", {}, {});
    expect(result.message).toBe("Not in this house");
  });

  it("handles handler that throws", async () => {
    const handler = () => {
      throw new Error("Handler exploded");
    };
    const wrapped = wrapPermissionHandler(handler);
    await expect(wrapped("Read", {}, {})).rejects.toThrow("Handler exploded");
  });
});

// ═══════════════════════════════════════════════════════
// SESSION: lifecycle edge cases
// ═══════════════════════════════════════════════════════

describe("session: lifecycle edge cases", () => {
  function mockQuery(
    handler: (prompt: AsyncIterable<any>) => AsyncIterable<Record<string, unknown>>
  ) {
    return vi.fn((args: any) => handler(args.prompt));
  }

  const MINIMAL_RESULT = {
    type: "result",
    subtype: "success",
    result: "",
    total_cost_usd: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  it("handles SDK returning zero messages (empty async generator)", async () => {
    const qfn = vi.fn(() => (async function* () {})());
    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("hello");
    // No result event means empty defaults
    expect(result.text).toBe("");
    expect(result.cost).toBe(0);
    expect(result.tools).toEqual([]);
  });

  it("handles send() to already-closed session", async () => {
    const qfn = vi.fn(() => (async function* () {})());
    const session = new Session(qfn, { cwd: "/" });
    session.close();
    await expect(session.send("hello")).rejects.toThrow("closed");
  });

  it("handles sendStream() to already-closed session", async () => {
    const qfn = vi.fn(() => (async function* () {})());
    const session = new Session(qfn, { cwd: "/" });
    session.close();

    const events = [];
    try {
      for await (const e of session.sendStream("hello")) {
        events.push(e);
      }
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("closed");
    }
  });

  it("handles close() before any send() (never started)", async () => {
    const qfn = vi.fn(() => (async function* () {})());
    const session = new Session(qfn, { cwd: "/" });
    session.close(); // should not throw
    expect(session.id).toBeNull();
  });

  it("handles close() during active send()", async () => {
    const qfn = vi.fn((args: any) =>
      (async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "working..." }] },
        };
        // Simulate long processing
        await new Promise((r) => setTimeout(r, 5000));
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const sendPromise = session.send("do work");

    // Close while send is in progress
    await new Promise((r) => setTimeout(r, 10));
    session.close();

    // send should resolve (background aborted, events drained)
    const result = await sendPromise;
    // May or may not have text depending on timing
    expect(result).toBeDefined();
  });

  it("handles external abort signal", async () => {
    const controller = new AbortController();

    const qfn = vi.fn((args: any) => {
      const ac = args.options.abortController as AbortController;
      return (async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "start" }] },
        };
        // Wait but respect abort (like the real SDK would)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          ac.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        yield MINIMAL_RESULT;
      })();
    });

    const session = new Session(qfn, { cwd: "/", signal: controller.signal });
    const sendPromise = session.send("work");

    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    const result = await sendPromise;
    expect(result).toBeDefined();
  });

  it("session.id is null before first send", () => {
    const qfn = vi.fn(() => (async function* () {})());
    const session = new Session(qfn, { cwd: "/" });
    expect(session.id).toBeNull();
  });

  it("session.id persists across multiple sends", async () => {
    const qfn = mockQuery(async function* (prompt) {
      for await (const msg of prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "persistent-id",
          model: "m",
          cwd: "/",
          tools: [],
        };
        yield MINIMAL_RESULT;
      }
    });

    const session = new Session(qfn, { cwd: "/" });
    await session.send("first");
    expect(session.id).toBe("persistent-id");

    await session.send("second");
    expect(session.id).toBe("persistent-id");

    session.close();
  });

  it("handles SDK throwing synchronously from query()", async () => {
    const qfn = vi.fn(() => {
      throw new Error("ANTHROPIC_API_KEY not set");
    });

    const session = new Session(qfn, { cwd: "/" });
    // The sync throw is caught inside startBackground and pushed as error event
    // send() sees the error event and throws an AgentError
    await expect(session.send("hello")).rejects.toMatchObject({
      code: "NOT_AUTHENTICATED",
    });
  });

  it("handles SDK throwing mid-iteration", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "partial" }] },
        };
        throw new Error("rate_limit exceeded");
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    try {
      await session.send("hello");
    } catch (err: any) {
      expect(err.code).toBe("RATE_LIMITED");
    }
  });

  it("handles SDK yielding multiple text blocks in one message", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "First paragraph." },
              { type: "text", text: "Second paragraph." },
            ],
          },
        };
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const events = [];
    for await (const e of session.sendStream("hi")) {
      events.push(e);
    }
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(2);
  });

  it("handles interleaved text and tool_use in one message", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me read that." },
              {
                type: "tool_use",
                id: "t1",
                name: "Read",
                input: { file_path: "/a.ts" },
              },
              { type: "text", text: "And also check this." },
              {
                type: "tool_use",
                id: "t2",
                name: "Read",
                input: { file_path: "/b.ts" },
              },
            ],
          },
        };
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const events = [];
    for await (const e of session.sendStream("check files")) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    expect(types).toEqual(["text", "tool_use", "text", "tool_use", "result"]);
  });

  it("handles tool_result with is_error=true", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "fail" } },
            ],
          },
        };
        yield {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "command not found: fail",
                is_error: true,
              },
            ],
          },
        };
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("run fail");
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].isError).toBe(true);
    expect(result.tools[0].output).toBe("command not found: fail");
  });

  it("handles tool_result for unknown tool_use_id", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "nonexistent",
                content: "result",
              },
            ],
          },
        };
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const events = [];
    for await (const e of session.sendStream("test")) {
      events.push(e);
    }
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0].type === "tool_result") {
      expect(toolResults[0].tool).toBe("unknown");
    }
  });
});

// ═══════════════════════════════════════════════════════
// SESSION: multi-turn correctness
// ═══════════════════════════════════════════════════════

describe("session: multi-turn deep tests", () => {
  const MINIMAL_RESULT = {
    type: "result",
    subtype: "success",
    result: "",
    total_cost_usd: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  it("accumulates cost across turns", async () => {
    let turn = 0;
    const qfn = vi.fn((args: any) => {
      const prompt = args.prompt;
      return (async function* () {
        for await (const _msg of prompt) {
          turn++;
          yield {
            type: "result",
            subtype: "success",
            result: `turn ${turn}`,
            total_cost_usd: 0.01 * turn,
            duration_ms: 1000 * turn,
            usage: { input_tokens: 10 * turn, output_tokens: 5 * turn },
          };
        }
      })();
    });

    const session = new Session(qfn, { cwd: "/" });
    const r1 = await session.send("one");
    expect(r1.cost).toBe(0.01);

    const r2 = await session.send("two");
    expect(r2.cost).toBe(0.02);

    const r3 = await session.send("three");
    expect(r3.cost).toBe(0.03);

    session.close();
  });

  it("tracks tool names across turns", async () => {
    let turn = 0;
    const qfn = vi.fn((args: any) => {
      const prompt = args.prompt;
      return (async function* () {
        for await (const _msg of prompt) {
          turn++;
          yield {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: `tool-turn-${turn}`,
                  name: turn === 1 ? "Read" : "Write",
                  input: { file_path: `/file${turn}.ts` },
                },
              ],
            },
          };
          yield {
            type: "user",
            tool_use_result: true,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: `tool-turn-${turn}`,
                  content: `result ${turn}`,
                },
              ],
            },
          };
          yield {
            ...MINIMAL_RESULT,
            result: `done turn ${turn}`,
          };
        }
      })();
    });

    const session = new Session(qfn, { cwd: "/" });

    const r1 = await session.send("read");
    expect(r1.tools[0].tool).toBe("Read");

    const r2 = await session.send("write");
    expect(r2.tools[0].tool).toBe("Write");

    session.close();
  });

  it("handles empty prompt string", async () => {
    const qfn = vi.fn((args: any) =>
      (async function* () {
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("");
    expect(result.text).toBe("");
  });

  it("handles very long prompt string", async () => {
    const longPrompt = "x".repeat(100_000);
    let capturedPrompt = "";

    const qfn = vi.fn((args: any) => {
      const prompt = args.prompt;
      return (async function* () {
        for await (const msg of prompt) {
          capturedPrompt = msg.message.content;
          yield MINIMAL_RESULT;
          return;
        }
      })();
    });

    const session = new Session(qfn, { cwd: "/" });
    await session.send(longPrompt);
    expect(capturedPrompt).toBe(longPrompt);
    session.close();
  });

  it("handles unicode in prompts", async () => {
    let captured = "";
    const qfn = vi.fn((args: any) => {
      const prompt = args.prompt;
      return (async function* () {
        for await (const msg of prompt) {
          captured = msg.message.content;
          yield MINIMAL_RESULT;
          return;
        }
      })();
    });

    const session = new Session(qfn, { cwd: "/" });
    await session.send("修复这个错误 🐛");
    expect(captured).toBe("修复这个错误 🐛");
    session.close();
  });
});

// ═══════════════════════════════════════════════════════
// SESSION: result collection edge cases
// ═══════════════════════════════════════════════════════

describe("session: result collection", () => {
  it("uses last text event as result text when result.text is empty", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "The actual answer" }] },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "", // empty result text
          total_cost_usd: 0.01,
          duration_ms: 100,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("question");
    // result.text should be "" because result event's text overrides (even if empty)
    // But the logic is: resultText = event.text || resultText
    // So empty string is falsy → keeps "The actual answer"
    expect(result.text).toBe("The actual answer");
  });

  it("result.text from result event overrides assistant text when non-empty", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Assistant said this" }] },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "Final summary",
          total_cost_usd: 0,
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("test");
    expect(result.text).toBe("Final summary");
  });

  it("handles multiple tool_use without matching tool_result", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Read", input: {} },
              { type: "tool_use", id: "t2", name: "Write", input: {} },
            ],
          },
        };
        // Only t1 gets a result, t2 is orphaned
        yield {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "partial",
          total_cost_usd: 0,
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("test");
    // Only one tool execution recorded (the one with a result)
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].tool).toBe("Read");
  });
});

// ═══════════════════════════════════════════════════════
// PRODUCT SENSE: API design validation
// ═══════════════════════════════════════════════════════

describe("product sense: API ergonomics", () => {
  it("session options are not mutated by internal code", async () => {
    const originalOptions = { cwd: "/test", model: "test-model" };
    const optionsCopy = { ...originalOptions };

    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "",
          total_cost_usd: 0,
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      })()
    );

    const session = new Session(qfn, originalOptions);
    await session.send("test");

    // Options should not be mutated
    expect(originalOptions).toEqual(optionsCopy);
  });

  it("AgentResult has all documented fields", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "test",
          model: "m",
          cwd: "/",
          tools: [],
        };
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          total_cost_usd: 0.05,
          duration_ms: 10000,
          usage: { input_tokens: 500, output_tokens: 200 },
        };
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("test");

    // Verify shape matches AgentResult interface
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("cost");
    expect(result).toHaveProperty("duration");
    expect(result).toHaveProperty("sessionId");
    expect(result).toHaveProperty("usage");
    expect(result).toHaveProperty("tools");
    expect(result.usage).toHaveProperty("input_tokens");
    expect(result.usage).toHaveProperty("output_tokens");

    // No extra properties
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["cost", "duration", "sessionId", "text", "tools", "usage"]);
  });

  it("AgentEvent discriminated union works with switch", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "s",
          model: "m",
          cwd: "/",
          tools: ["Read"],
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "hi" },
          },
        };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "hello" }] },
        };
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/" } },
            ],
          },
        };
        yield {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "data" },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          total_cost_usd: 0,
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const eventTypes = new Set<string>();

    for await (const event of session.sendStream("test")) {
      eventTypes.add(event.type);

      // Verify discriminated union — each type has correct fields
      switch (event.type) {
        case "system":
          expect(event.sessionId).toBeDefined();
          expect(event.model).toBeDefined();
          break;
        case "text_delta":
          expect(event.delta).toBeDefined();
          break;
        case "text":
          expect(event.text).toBeDefined();
          break;
        case "tool_use":
          expect(event.id).toBeDefined();
          expect(event.tool).toBeDefined();
          expect(event.description).toBeDefined();
          break;
        case "tool_result":
          expect(event.toolUseId).toBeDefined();
          expect(event.output).toBeDefined();
          break;
        case "result":
          expect(event.cost).toBeDefined();
          expect(event.duration).toBeDefined();
          break;
        case "error":
          expect(event.error).toBeDefined();
          break;
      }
    }

    expect(eventTypes).toEqual(
      new Set(["system", "text_delta", "text", "tool_use", "tool_result", "result"])
    );
  });
});

// ═══════════════════════════════════════════════════════
// INTEGRATION: full realistic flows
// ═══════════════════════════════════════════════════════

describe("integration: realistic agent flows", () => {
  it("simulates a typical code edit flow", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "edit-session",
          model: "claude-sonnet-4-20250514",
          cwd: "/project",
          tools: ["Read", "Edit", "Bash", "Glob", "Grep"],
        };

        // Claude reads the file
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me look at the file." },
              {
                type: "tool_use",
                id: "read1",
                name: "Read",
                input: { file_path: "/project/src/auth.ts" },
              },
            ],
          },
        };

        yield {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read1",
                content: "export function login() { /* old code */ }",
              },
            ],
          },
        };

        // Claude edits the file
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "I'll fix the authentication logic." },
              {
                type: "tool_use",
                id: "edit1",
                name: "Edit",
                input: {
                  file_path: "/project/src/auth.ts",
                  old_string: "/* old code */",
                  new_string: "return validateToken(token);",
                },
              },
            ],
          },
        };

        yield {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "edit1",
                content: "File edited successfully",
              },
            ],
          },
        };

        // Final result
        yield {
          type: "result",
          subtype: "success",
          result: "Fixed the authentication logic in auth.ts by adding proper token validation.",
          total_cost_usd: 0.032,
          duration_ms: 8500,
          usage: { input_tokens: 1200, output_tokens: 450 },
        };
      })()
    );

    const session = new Session(qfn, { cwd: "/project" });
    const result = await session.send("Fix the login bug in auth.ts");

    expect(result.text).toBe(
      "Fixed the authentication logic in auth.ts by adding proper token validation."
    );
    expect(result.cost).toBe(0.032);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].tool).toBe("Read");
    expect(result.tools[1].tool).toBe("Edit");
    expect(result.tools[1].isError).toBe(false);
    expect(result.sessionId).toBe("edit-session");
  });

  it("simulates error recovery flow", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "err-session",
          model: "m",
          cwd: "/",
          tools: [],
        };

        // Claude runs a command that fails
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "bash1",
                name: "Bash",
                input: { command: "npm test" },
              },
            ],
          },
        };

        yield {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "bash1",
                content: "FAIL: 3 tests failed\nTypeError: Cannot read property 'id' of undefined",
                is_error: true,
              },
            ],
          },
        };

        // Claude tries to fix
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Tests are failing. Let me fix the issue." },
            ],
          },
        };

        yield {
          type: "result",
          subtype: "success",
          result: "Fixed 3 failing tests.",
          total_cost_usd: 0.05,
          duration_ms: 15000,
          usage: { input_tokens: 2000, output_tokens: 800 },
        };
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("fix tests");

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].isError).toBe(true);
    expect(result.tools[0].output).toContain("3 tests failed");
  });
});
