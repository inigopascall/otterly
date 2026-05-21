import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import type { PermissionHandler } from "../src/types.js";

/**
 * Tests that permissions actually flow through the full stack:
 * EngineOptions.onPermission → wrapPermissionHandler → SDK canUseTool → tool execution
 */
describe("permissions: full-stack integration", () => {
  const MINIMAL_RESULT = {
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  it("onPermission causes permissionMode to be set to 'default'", async () => {
    let capturedOptions: Record<string, unknown> = {};

    const qfn = vi.fn((args: any) => {
      capturedOptions = args.options;
      return (async function* () {
        yield MINIMAL_RESULT;
      })();
    });

    const handler: PermissionHandler = () => ({ allow: true });
    const session = new Session(qfn, { cwd: "/", onPermission: handler });
    await session.send("test");

    expect(capturedOptions.permissionMode).toBe("default");
    expect(typeof capturedOptions.canUseTool).toBe("function");
  });

  it("onPermission overrides explicit permissionMode", async () => {
    let capturedOptions: Record<string, unknown> = {};

    const qfn = vi.fn((args: any) => {
      capturedOptions = args.options;
      return (async function* () {
        yield MINIMAL_RESULT;
      })();
    });

    const session = new Session(qfn, {
      cwd: "/",
      permissionMode: "bypassPermissions",
      onPermission: () => ({ allow: true }),
    });
    await session.send("test");

    // onPermission should force "default" even though "bypassPermissions" was set
    expect(capturedOptions.permissionMode).toBe("default");
  });

  it("without onPermission, defaults to bypassPermissions", async () => {
    let capturedOptions: Record<string, unknown> = {};

    const qfn = vi.fn((args: any) => {
      capturedOptions = args.options;
      return (async function* () {
        yield MINIMAL_RESULT;
      })();
    });

    const session = new Session(qfn, { cwd: "/" });
    await session.send("test");

    expect(capturedOptions.permissionMode).toBe("bypassPermissions");
    expect(capturedOptions.canUseTool).toBeUndefined();
  });

  it("canUseTool callback receives correct tool info", async () => {
    let capturedCanUseTool: Function | undefined;

    const qfn = vi.fn((args: any) => {
      capturedCanUseTool = args.options.canUseTool as Function;
      return (async function* () {
        yield MINIMAL_RESULT;
      })();
    });

    const permissionCalls: Array<{ tool: string; input: any; reason?: string }> = [];

    const session = new Session(qfn, {
      cwd: "/",
      onPermission: (req) => {
        permissionCalls.push(req);
        return { allow: true };
      },
    });
    await session.send("test");

    // Now simulate the SDK calling canUseTool
    expect(capturedCanUseTool).toBeDefined();
    const result = await capturedCanUseTool!(
      "Bash",
      { command: "npm test" },
      { decisionReason: "Need to run tests" }
    );

    expect(permissionCalls).toHaveLength(1);
    expect(permissionCalls[0]).toEqual({
      tool: "Bash",
      input: { command: "npm test" },
      reason: "Need to run tests",
    });
    expect(result.behavior).toBe("allow");
  });

  it("canUseTool deny response includes message", async () => {
    let capturedCanUseTool: Function | undefined;

    const qfn = vi.fn((args: any) => {
      capturedCanUseTool = args.options.canUseTool as Function;
      return (async function* () {
        yield MINIMAL_RESULT;
      })();
    });

    const session = new Session(qfn, {
      cwd: "/",
      onPermission: ({ tool }) => {
        if (tool === "Bash") {
          return { allow: false, message: "Shell access denied" };
        }
        return { allow: true };
      },
    });
    await session.send("test");

    const result = await capturedCanUseTool!("Bash", { command: "rm -rf /" }, {});
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe("Shell access denied");
  });
});

describe("permissions: option forwarding", () => {
  const MINIMAL_RESULT = {
    type: "result",
    subtype: "success",
    result: "",
    total_cost_usd: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  it("forwards allowedTools", async () => {
    let captured: Record<string, unknown> = {};
    const qfn = vi.fn((args: any) => {
      captured = args.options;
      return (async function* () { yield MINIMAL_RESULT; })();
    });

    const session = new Session(qfn, {
      cwd: "/",
      allowedTools: ["Read", "Glob"],
    });
    await session.send("test");
    expect(captured.allowedTools).toEqual(["Read", "Glob"]);
  });

  it("forwards disallowedTools", async () => {
    let captured: Record<string, unknown> = {};
    const qfn = vi.fn((args: any) => {
      captured = args.options;
      return (async function* () { yield MINIMAL_RESULT; })();
    });

    const session = new Session(qfn, {
      cwd: "/",
      disallowedTools: ["Bash"],
    });
    await session.send("test");
    expect(captured.disallowedTools).toEqual(["Bash"]);
  });

  it("forwards effort", async () => {
    let captured: Record<string, unknown> = {};
    const qfn = vi.fn((args: any) => {
      captured = args.options;
      return (async function* () { yield MINIMAL_RESULT; })();
    });

    const session = new Session(qfn, { cwd: "/", effort: "high" });
    await session.send("test");
    expect(captured.effort).toBe("high");
  });

  it("forwards systemPrompt", async () => {
    let captured: Record<string, unknown> = {};
    const qfn = vi.fn((args: any) => {
      captured = args.options;
      return (async function* () { yield MINIMAL_RESULT; })();
    });

    const session = new Session(qfn, {
      cwd: "/",
      systemPrompt: "You are a testing bot",
    });
    await session.send("test");
    expect(captured.systemPrompt).toBe("You are a testing bot");
  });

  it("forwards mcpServers", async () => {
    let captured: Record<string, unknown> = {};
    const qfn = vi.fn((args: any) => {
      captured = args.options;
      return (async function* () { yield MINIMAL_RESULT; })();
    });

    const mcpConfig = { github: { url: "http://localhost:3000" } };
    const session = new Session(qfn, { cwd: "/", mcpServers: mcpConfig });
    await session.send("test");
    expect(captured.mcpServers).toEqual(mcpConfig);
  });

  it("does not forward undefined options", async () => {
    let captured: Record<string, unknown> = {};
    const qfn = vi.fn((args: any) => {
      captured = args.options;
      return (async function* () { yield MINIMAL_RESULT; })();
    });

    const session = new Session(qfn, { cwd: "/" });
    await session.send("test");

    // These should NOT be in the options (undefined values skipped)
    expect("model" in captured).toBe(false);
    expect("maxTurns" in captured).toBe(false);
    expect("allowedTools" in captured).toBe(false);
    expect("disallowedTools" in captured).toBe(false);
    expect("effort" in captured).toBe(false);
    expect("resume" in captured).toBe(false);
    expect("systemPrompt" in captured).toBe(false);
    expect("mcpServers" in captured).toBe(false);
  });

  it("always sets includePartialMessages", async () => {
    let captured: Record<string, unknown> = {};
    const qfn = vi.fn((args: any) => {
      captured = args.options;
      return (async function* () { yield MINIMAL_RESULT; })();
    });

    const session = new Session(qfn, { cwd: "/" });
    await session.send("test");
    expect(captured.includePartialMessages).toBe(true);
  });

  it("always creates its own abortController", async () => {
    let captured: Record<string, unknown> = {};
    const qfn = vi.fn((args: any) => {
      captured = args.options;
      return (async function* () { yield MINIMAL_RESULT; })();
    });

    const session = new Session(qfn, { cwd: "/" });
    await session.send("test");
    expect(captured.abortController).toBeInstanceOf(AbortController);
  });
});
