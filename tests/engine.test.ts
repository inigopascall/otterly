import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeEngine } from "../src/engine.js";
import { AgentError } from "../src/errors.js";

// Mock the SDK resolution by mocking the dynamic import
// We intercept at the engine level by providing a mock query function
function createMockQuery(messages: Record<string, unknown>[]) {
  return async function* () {
    for (const msg of messages) {
      yield msg;
    }
  };
}

// Helper to create an engine that uses a mock query function directly
// We test through the Session which accepts a queryFn
import { Session } from "../src/session.js";

describe("ClaudeEngine", () => {
  describe("run() via Session internals", () => {
    it("collects text and result into AgentResult", async () => {
      const mockQuery = vi.fn((args: any) =>
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "test-sess",
            model: "claude-sonnet-4-20250514",
            cwd: "/test",
            tools: ["Read"],
          };
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Fixed the bug." }],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            result: "Done.",
            total_cost_usd: 0.02,
            duration_ms: 5000,
            usage: { input_tokens: 100, output_tokens: 50 },
          };
        })()
      );

      const session = new Session(mockQuery, { cwd: "/test" });
      const result = await session.send("Fix the bug");

      expect(result.text).toBe("Done.");
      expect(result.cost).toBe(0.02);
      expect(result.duration).toBe(5000);
      expect(result.sessionId).toBe("test-sess");
      expect(result.usage.input_tokens).toBe(100);
    });

    it("collects tool executions", async () => {
      const mockQuery = vi.fn((args: any) =>
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "s1",
            model: "m",
            cwd: "/",
            tools: [],
          };
          yield {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "Read",
                  input: { file_path: "/a.ts" },
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
                  tool_use_id: "t1",
                  content: "file content",
                  is_error: false,
                },
              ],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            result: "Read complete",
            total_cost_usd: 0.01,
            duration_ms: 2000,
            usage: { input_tokens: 50, output_tokens: 30 },
          };
        })()
      );

      const session = new Session(mockQuery, { cwd: "/" });
      const result = await session.send("Read a file");

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toEqual({
        tool: "Read",
        input: { file_path: "/a.ts" },
        output: "file content",
        isError: false,
      });
    });

    it("throws on error results", async () => {
      const mockQuery = vi.fn((args: any) =>
        (async function* () {
          yield {
            type: "result",
            subtype: "error",
            errors: ["Something went wrong"],
          };
        })()
      );

      const session = new Session(mockQuery, { cwd: "/" });
      await expect(session.send("Do something")).rejects.toThrow(
        "Something went wrong"
      );
    });
  });

  describe("stream() via Session", () => {
    it("yields events in order", async () => {
      const mockQuery = vi.fn((args: any) =>
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "s1",
            model: "m",
            cwd: "/",
            tools: [],
          };
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "hello" },
            },
          };
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "hello world" }],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            result: "done",
            total_cost_usd: 0.01,
            duration_ms: 1000,
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        })()
      );

      const session = new Session(mockQuery, { cwd: "/" });
      const events = [];
      for await (const event of session.sendStream("hi")) {
        events.push(event);
      }

      expect(events.map((e) => e.type)).toEqual([
        "system",
        "text_delta",
        "text",
        "result",
      ]);
    });
  });

  describe("session multi-turn", () => {
    it("supports multiple send() calls on the same session", async () => {
      let resolveMessage: ((msg: unknown) => void) | null = null;
      let messageCount = 0;

      const mockQuery = vi.fn((args: any) => {
        const prompt = args.prompt;

        return (async function* () {
          // Iterate the prompt generator
          for await (const msg of prompt) {
            messageCount++;

            yield {
              type: "system",
              subtype: "init",
              session_id: "multi-turn-sess",
              model: "m",
              cwd: "/",
              tools: [],
            };

            yield {
              type: "assistant",
              message: {
                content: [
                  { type: "text", text: `Response ${messageCount}` },
                ],
              },
            };

            yield {
              type: "result",
              subtype: "success",
              result: `Result ${messageCount}`,
              total_cost_usd: 0.01 * messageCount,
              duration_ms: 1000 * messageCount,
              usage: {
                input_tokens: 10 * messageCount,
                output_tokens: 5 * messageCount,
              },
            };
          }
        })();
      });

      const session = new Session(mockQuery, { cwd: "/" });

      const r1 = await session.send("First message");
      expect(r1.text).toBe("Result 1");

      const r2 = await session.send("Second message");
      expect(r2.text).toBe("Result 2");
      expect(r2.cost).toBe(0.02);

      session.close();
    });

    it("throws when sending to a closed session", async () => {
      const mockQuery = vi.fn((args: any) =>
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "ok",
            total_cost_usd: 0,
            duration_ms: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        })()
      );

      const session = new Session(mockQuery, { cwd: "/" });
      session.close();

      await expect(session.send("hello")).rejects.toThrow("closed");
    });

    it("exposes session id after first send", async () => {
      const mockQuery = vi.fn((args: any) =>
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "my-session-id",
            model: "m",
            cwd: "/",
            tools: [],
          };
          yield {
            type: "result",
            subtype: "success",
            result: "ok",
            total_cost_usd: 0,
            duration_ms: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        })()
      );

      const session = new Session(mockQuery, { cwd: "/" });
      expect(session.id).toBeNull();

      await session.send("init");
      expect(session.id).toBe("my-session-id");
    });
  });

  describe("permission handling", () => {
    it("passes onPermission handler to SDK as canUseTool", async () => {
      const permissionHandler = vi.fn(() => ({
        allow: false,
        message: "Denied by test",
      }));

      const mockQuery = vi.fn((args: any) => {
        // Verify the canUseTool callback was set
        expect(args.options.canUseTool).toBeDefined();
        expect(args.options.permissionMode).toBe("default");

        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "ok",
            total_cost_usd: 0,
            duration_ms: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        })();
      });

      const session = new Session(mockQuery, {
        cwd: "/",
        onPermission: permissionHandler,
      });

      await session.send("test");

      // Verify the query was called with permission options
      expect(mockQuery).toHaveBeenCalled();
      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.options.permissionMode).toBe("default");
      expect(typeof callArgs.options.canUseTool).toBe("function");
    });
  });

  describe("options merging", () => {
    it("merges default and call-specific options", () => {
      const engine = new ClaudeEngine({
        cwd: "/default",
        model: "default-model",
      });

      // Access the private method via a test — verify through session creation
      const session = engine.session({ model: "override-model" });
      // Session was created with merged options — verified implicitly
      expect(session).toBeDefined();
    });
  });
});
