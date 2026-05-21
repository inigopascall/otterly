import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";

describe("Session", () => {
  describe("close()", () => {
    it("is idempotent — calling close() twice does not throw", () => {
      const mockQuery = vi.fn(() => (async function* () {})());
      const session = new Session(mockQuery, { cwd: "/" });
      session.close();
      session.close(); // should not throw
    });
  });

  describe("sendStream()", () => {
    it("yields system event with session ID", async () => {
      const mockQuery = vi.fn((args: any) =>
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "stream-sess",
            model: "test",
            cwd: "/test",
            tools: ["Read", "Write"],
          };
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

      const session = new Session(mockQuery, { cwd: "/test" });
      const events = [];
      for await (const e of session.sendStream("hi")) {
        events.push(e);
      }

      expect(events[0]).toEqual({
        type: "system",
        sessionId: "stream-sess",
        model: "test",
        cwd: "/test",
        tools: ["Read", "Write"],
      });
    });

    it("stops yielding after result event (allows next turn)", async () => {
      let yieldCount = 0;

      const mockQuery = vi.fn((args: any) => {
        const prompt = args.prompt;
        return (async function* () {
          for await (const msg of prompt) {
            yieldCount++;
            yield {
              type: "assistant",
              message: {
                content: [{ type: "text", text: `Turn ${yieldCount}` }],
              },
            };
            yield {
              type: "result",
              subtype: "success",
              result: `Result ${yieldCount}`,
              total_cost_usd: 0,
              duration_ms: 0,
              usage: { input_tokens: 0, output_tokens: 0 },
            };
            // More messages after result should NOT be yielded in this turn
            yield {
              type: "assistant",
              message: {
                content: [{ type: "text", text: "Should not appear" }],
              },
            };
          }
        })();
      });

      const session = new Session(mockQuery, { cwd: "/" });
      const events = [];
      for await (const e of session.sendStream("first")) {
        events.push(e);
      }

      const types = events.map((e) => e.type);
      expect(types).toContain("text");
      expect(types).toContain("result");
      // The "Should not appear" text should not be in this turn
      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.every((e) => e.type === "text" && !("text" in e && e.text === "Should not appear"))).toBe(true);
    });
  });

  describe("error handling", () => {
    it("throws classified error when SDK query fails", async () => {
      const mockQuery = vi.fn(() => {
        return (async function* () {
          throw new Error("ANTHROPIC_API_KEY not set");
        })();
      });

      const session = new Session(mockQuery, { cwd: "/" });

      try {
        await session.send("test");
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.code).toBe("NOT_AUTHENTICATED");
      }
    });
  });

  describe("options forwarding", () => {
    it("passes cwd to query options", async () => {
      const mockQuery = vi.fn((args: any) => {
        expect(args.options.cwd).toBe("/my/project");
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "",
            total_cost_usd: 0,
            duration_ms: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        })();
      });

      const session = new Session(mockQuery, { cwd: "/my/project" });
      await session.send("test");
      expect(mockQuery).toHaveBeenCalled();
    });

    it("passes model to query options", async () => {
      const mockQuery = vi.fn((args: any) => {
        expect(args.options.model).toBe("claude-opus-4-20250514");
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "",
            total_cost_usd: 0,
            duration_ms: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        })();
      });

      const session = new Session(mockQuery, {
        cwd: "/",
        model: "claude-opus-4-20250514",
      });
      await session.send("test");
    });

    it("defaults permission mode to bypassPermissions", async () => {
      const mockQuery = vi.fn((args: any) => {
        expect(args.options.permissionMode).toBe("bypassPermissions");
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "",
            total_cost_usd: 0,
            duration_ms: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        })();
      });

      const session = new Session(mockQuery, { cwd: "/" });
      await session.send("test");
    });

    it("passes resume option for session continuation", async () => {
      const mockQuery = vi.fn((args: any) => {
        expect(args.options.resume).toBe("prev-session-id");
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "",
            total_cost_usd: 0,
            duration_ms: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        })();
      });

      const session = new Session(mockQuery, {
        cwd: "/",
        resume: "prev-session-id",
      });
      await session.send("continue");
    });
  });
});
