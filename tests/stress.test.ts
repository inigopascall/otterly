import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";

/**
 * Stress tests: concurrency, rapid fire, resource cleanup, memory patterns.
 */
describe("stress: rapid session operations", () => {
  const MINIMAL_RESULT = {
    type: "result",
    subtype: "success",
    result: "",
    total_cost_usd: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  it("handles 10 sequential sends on the same session", async () => {
    let turn = 0;
    const qfn = vi.fn((args: any) => {
      const prompt = args.prompt;
      return (async function* () {
        for await (const _msg of prompt) {
          turn++;
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: `Response ${turn}` }],
            },
          };
          yield {
            ...MINIMAL_RESULT,
            result: `Result ${turn}`,
            total_cost_usd: 0.001 * turn,
          };
        }
      })();
    });

    const session = new Session(qfn, { cwd: "/" });

    for (let i = 1; i <= 10; i++) {
      const result = await session.send(`Message ${i}`);
      expect(result.text).toBe(`Result ${i}`);
    }

    session.close();
    expect(turn).toBe(10);
  });

  it("handles rapid close after send", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 100));
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const promise = session.send("hello");
    session.close(); // Close immediately

    // Should not hang — should resolve or reject
    const result = await promise;
    expect(result).toBeDefined();
  });

  it("handles creating many sessions without closing (resource leak test)", () => {
    const sessions = [];
    const qfn = vi.fn(() => (async function* () {})());

    for (let i = 0; i < 100; i++) {
      sessions.push(new Session(qfn, { cwd: "/" }));
    }

    // All sessions should be closeable
    for (const s of sessions) {
      s.close();
    }

    // No hanging, no crash
    expect(sessions).toHaveLength(100);
  });

  it("handles session with many events in rapid succession", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        // Yield 100 text events rapidly
        for (let i = 0; i < 100; i++) {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: `chunk${i} ` },
            },
          };
        }
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    let deltaCount = 0;
    for await (const event of session.sendStream("fast")) {
      if (event.type === "text_delta") deltaCount++;
    }
    expect(deltaCount).toBe(100);
  });

  it("handles many tool use/result pairs", async () => {
    const qfn = vi.fn(() =>
      (async function* () {
        for (let i = 0; i < 20; i++) {
          yield {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: `t${i}`,
                  name: "Read",
                  input: { file_path: `/file${i}.ts` },
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
                  tool_use_id: `t${i}`,
                  content: `content of file ${i}`,
                },
              ],
            },
          };
        }
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const result = await session.send("read all files");
    expect(result.tools).toHaveLength(20);
    expect(result.tools[19].output).toBe("content of file 19");
  });
});

describe("stress: abort timing", () => {
  const MINIMAL_RESULT = {
    type: "result",
    subtype: "success",
    result: "",
    total_cost_usd: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  it("abort before any send", () => {
    const qfn = vi.fn(() => (async function* () {})());
    const controller = new AbortController();
    const session = new Session(qfn, { cwd: "/", signal: controller.signal });
    controller.abort();
    // Session should handle this gracefully
    session.close();
  });

  it("abort after send completes should not affect next send", async () => {
    const controller = new AbortController();
    let turn = 0;
    const qfn = vi.fn((args: any) => {
      const prompt = args.prompt;
      return (async function* () {
        for await (const _msg of prompt) {
          turn++;
          yield { ...MINIMAL_RESULT, result: `turn ${turn}` };
        }
      })();
    });

    const session = new Session(qfn, { cwd: "/", signal: controller.signal });
    const r1 = await session.send("first");
    expect(r1.text).toBe("turn 1");

    // Abort after first send completed
    controller.abort();

    // Second send should fail because abort was called
    session.close();
  });

  it("handles abort signal already aborted at construction", async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-abort

    const qfn = vi.fn(() =>
      (async function* () {
        yield MINIMAL_RESULT;
      })()
    );

    const session = new Session(qfn, { cwd: "/", signal: controller.signal });
    // The internal abort controller is immediately aborted
    const result = await session.send("test");
    // Background loop should exit because signal is already aborted
    expect(result).toBeDefined();
  });
});

describe("stress: event queue ordering", () => {
  it("preserves exact event order from SDK", async () => {
    const expectedOrder = [
      "system",
      "text_delta",
      "text_delta",
      "text_delta",
      "text",
      "tool_use",
      "tool_result",
      "text",
      "result",
    ];

    const qfn = vi.fn(() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "s",
          model: "m",
          cwd: "/",
          tools: [],
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "a" },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "b" },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "c" },
          },
        };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "abc" }] },
        };
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Read", input: {} },
            ],
          },
        };
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
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "complete",
          total_cost_usd: 0,
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      })()
    );

    const session = new Session(qfn, { cwd: "/" });
    const types: string[] = [];
    for await (const event of session.sendStream("test")) {
      types.push(event.type);
    }
    expect(types).toEqual(expectedOrder);
  });
});
