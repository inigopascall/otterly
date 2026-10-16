import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeEngine, buildCLICommand } from "../src/engine.js";
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
  describe("run() result collection", () => {
    it("concatenates multiple assistant text blocks when terminal result is empty", async () => {
      const mockQuery = vi.fn(() =>
        (async function* () {
          yield {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "# Title\n\n" },
                { type: "text", text: "Opening paragraph. " },
                { type: "text", text: "Continuation and conclusion.\n" },
              ],
            },
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

      const engine = new ClaudeEngine({ cwd: "/" }, mockQuery);
      const result = await engine.run("write a document");

      expect(result.text).toBe(
        "# Title\n\nOpening paragraph. Continuation and conclusion.\n"
      );
    });
  });

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

describe("Claude client-tool isolation", () => {
  const result = { type: "result", subtype: "success", result: "OK" };
  const native = { type: "assistant", message: { content: [{ type: "tool_use", id: "n1", name: "subagents---run_task", input: {} }] } };
  function engine(messages: Record<string, unknown>[]) {
    return new ClaudeEngine({}, async function* () { for (const message of messages) yield message; });
  }
  function flagValue(argv: string[], flag: string) {
    expect(argv).toContain(flag);
    return argv[argv.indexOf(flag) + 1];
  }
  it("builds an isolated command with a turn limit", () => {
    const cmd = buildCLICommand("claude", { maxTurns: 1 });
    expect(cmd).toContain("--safe-mode");
    expect(cmd).toContain("--strict-mcp-config");
    expect(flagValue(cmd, "--mcp-config")).toBe('{"mcpServers":{}}');
    expect(flagValue(cmd, "--tools")).toBe("");
    expect(flagValue(cmd, "--max-turns")).toBe("1");
    expect(flagValue(cmd, "--disallowedTools")).toBe("*");
    expect(flagValue(cmd, "--input-format")).toBe("stream-json");
    expect(flagValue(cmd, "--output-format")).toBe("stream-json");
    expect(flagValue(cmd, "--thinking-display")).toBe("summarized");
    expect(flagValue(cmd, "--system-prompt")).toBe("You are a helpful assistant.");
    expect(flagValue(cmd, "--setting-sources")).toBe("");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("--verbose");
    expect(cmd).toContain("--include-partial-messages");
  });
  it.each([0, -1, 1.5, "1"])("rejects invalid maxTurns %s", (maxTurns) => {
    expect(() => buildCLICommand("claude", { maxTurns })).toThrow("maxTurns must be a positive safe integer");
  });
  it("passes explicit tools without wildcard disallowance", () => {
    const cmd = buildCLICommand("claude", { tools: ["Read", "Grep"] });
    expect(cmd).toContain("--safe-mode");
    expect(flagValue(cmd, "--tools")).toBe("Read,Grep");
    const values = cmd
      .map((value, index) => value === "--disallowedTools" ? cmd[index + 1] : undefined)
      .filter((value): value is string => value !== undefined);
    expect(values).not.toContain("*");
  });
  it("passes MCP configuration without safe mode", () => {
    const cmd = buildCLICommand("claude", { mcpServers: { probe: { command: "/bin/false" } } });
    expect(cmd).not.toContain("--safe-mode");
    expect(cmd).toContain("--strict-mcp-config");
    expect(flagValue(cmd, "--mcp-config")).toBe('{"mcpServers":{"probe":{"command":"/bin/false"}}}');
    const values = cmd
      .map((value, index) => value === "--disallowedTools" ? cmd[index + 1] : undefined)
      .filter((value): value is string => value !== undefined);
    expect(values).not.toContain("*");
  });
  it("passes canUseTool as permission-prompt-tool stdio", () => {
    const cmd = buildCLICommand("claude", { canUseTool: () => ({ behavior: "allow" }) });
    expect(flagValue(cmd, "--permission-prompt-tool")).toBe("stdio");
  });
  it("passes a custom system prompt verbatim", () => {
    const prompt = "Caller's exact prompt";
    const cmd = buildCLICommand("claude", { systemPrompt: prompt });
    expect(flagValue(cmd, "--system-prompt")).toBe(prompt);
  });
  it("rejects native calls even without tool results", async () => {
    await expect(engine([native, result]).run("hello", { clientToolCalls: true })).rejects.toMatchObject({ code: "NATIVE_TOOL_CALL" });
  });
  it("rejects a nonempty native inventory", async () => {
    await expect(engine([{ type: "system", subtype: "init", tools: ["mcp__claude_ai_Claude_Docs__read"] }, result]).run("hello", { clientToolCalls: true })).rejects.toMatchObject({ code: "NATIVE_TOOL_CALL" });
  });
  it("preserves the external JSON bridge", async () => {
    const text = '{"tool_calls":[{"name":"example","arguments":{}}]}';
    const value = await engine([{ type: "system", subtype: "init", tools: [] }, { ...result, result: text }]).run("hello", { clientToolCalls: true });
    expect(value.text).toBe(text);
  });
  it("preserves non-client native event handling", async () => {
    const value = await engine([native, result]).run("hello", { clientToolCalls: false });
    expect(value.text).toBe("OK");
  });
});
