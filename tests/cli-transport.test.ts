import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeEngine, createCLIQueryFn } from "../src/engine.js";

// The transport between ClaudeEngine/Session and the claude CLI, driven against
// tests/fixtures/fake-claude.mjs, which speaks the CLI's stream-json protocol.
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
let dir = "";
let bin = "";
let logFile = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "otterly-fake-claude-"));
  bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(bin, 0o755);
});

afterAll(() => {
  delete process.env.FAKE_CLAUDE_LOG;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  logFile = join(dir, `log-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
  process.env.FAKE_CLAUDE_LOG = logFile;
});

function logged(): Array<Record<string, any>> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
const stdinMessages = () => logged().filter((e) => e.stdin).map((e) => JSON.parse(e.stdin));
const spawns = () => logged().filter((e) => e.argv);
const engine = (defaults: Record<string, unknown> = {}) =>
  new ClaudeEngine({ cwd: dir, ...defaults }, createCLIQueryFn(bin));

describe("claude CLI transport (stream-json over stdio)", () => {
  it("sends a one-shot prompt as one user message, then closes stdin", async () => {
    const result = await engine().run("hello");
    expect(result.text).toBe("echo: hello");
    expect(result.sessionId).toBe("fake-session");
    expect(stdinMessages()).toEqual([
      { type: "user", message: { role: "user", content: "hello" }, parent_tool_use_id: null },
    ]);
    expect(spawns()[0].argv.slice(0, 6)).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    ]);
  });

  it("runs every Session turn in one CLI process", async () => {
    const session = engine().session();
    try {
      expect((await session.send("first")).text).toBe("echo: first");
      expect((await session.send("second")).text).toBe("echo: second");
    } finally {
      session.close();
    }
    expect(spawns()).toHaveLength(1);
    expect(stdinMessages().map((m) => m.message.content)).toEqual(["first", "second"]);
  });

  it("answers a permission request with the handler's decision", async () => {
    const asked: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const result = await engine().run("ASK Write", {
      onPermission: ({ tool, input }) => {
        asked.push({ tool, input });
        return { allow: true, updatedInput: { path: "y" } };
      },
    });
    expect(asked).toEqual([{ tool: "Write", input: { path: "x" } }]);
    expect(result.text).toBe('allow: {"path":"y"}');
    expect(stdinMessages().find((m) => m.type === "control_response")).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "req-1", response: { behavior: "allow", updatedInput: { path: "y" } } },
    });
    const argv = spawns()[0].argv as string[];
    expect(argv[argv.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
  });

  it("passes a denial and its message back to the CLI", async () => {
    const result = await engine().run("ASK Bash", {
      onPermission: () => ({ allow: false, message: "not here" }),
    });
    expect(result.text).toBe("deny: not here");
  });

  it("denies a permission request when no handler is set", async () => {
    const result = await engine().run("ASK Bash");
    expect(result.text).toMatch(/^deny: /);
  });

  it("does not stop a Session that is waiting for its next message", async () => {
    const session = engine({ idleTimeoutMs: 300 }).session();
    try {
      await session.send("first");
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect((await session.send("second")).text).toBe("echo: second");
    } finally {
      session.close();
    }
  });

  it("stops a turn that goes silent past the idle limit", async () => {
    await expect(engine().run("SILENT 2000", { idleTimeoutMs: 300 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
