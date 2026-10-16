/**
 * The CLI suite: checks the installed `claude` against everything Otterly
 * relies on. Run it after every Claude Code upgrade:
 *
 *   pnpm dlx vitest run --config vitest.cli.config.ts
 *
 * The flag checks cost nothing (probeClaudeCLI). The conversation checks make
 * a few short, low-effort calls on your Claude Code subscription.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeEngine,
  EFFORT_LEVELS,
  TESTED_CLAUDE_CLI_VERSION,
  cliSemver,
  findClaudeCLI,
  probeClaudeCLI,
  verifyClaudeCLI,
} from "../src/engine.js";
import { DEFAULT_MODEL } from "../src/server/models.js";
import type { AgentEvent, ToolRequest } from "../src/types.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "otterly-cli-suite-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the installed claude CLI", () => {
  it("is on PATH", () => {
    const cli = findClaudeCLI();
    expect(cli, "no claude CLI on PATH").not.toBeNull();
    console.log(`claude ${cli!.version} at ${cli!.path}; this build was tested with ${TESTED_CLAUDE_CLI_VERSION}`);
    expect(cliSemver(cli!.version)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("passes the server's startup check: flags accepted, no tools, no MCP servers", async () => {
    const check = await verifyClaudeCLI();
    expect(check.problem ?? "").toBe("");
    expect(check.ok).toBe(true);
  });
});

describe("every flag Otterly can pass (no model calls)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ...EFFORT_LEVELS.map((effort): [string, Record<string, unknown>] => [`--effort ${effort}`, { effort }]),
    [`--model ${DEFAULT_MODEL}`, { model: DEFAULT_MODEL }],
    ["--max-turns", { maxTurns: 3 }],
    ["--permission-mode bypassPermissions", { permissionMode: "bypassPermissions" }],
    [
      "--permission-mode default with --permission-prompt-tool stdio",
      { permissionMode: "default", canUseTool: async () => ({ behavior: "deny", message: "no" }) },
    ],
    [
      "--allowedTools and --disallowedTools, including an unknown tool name",
      { allowedTools: ["Read"], disallowedTools: ["Bash", "NoSuchToolXyz"] },
    ],
    ["--tools with names", { tools: ["Read", "Grep"] }],
    ["--tools default", { tools: ["default"] }],
    ["--system-prompt with quotes and newlines", { systemPrompt: "You're terse.\nAnswer in \"one\" word." }],
    ["--mcp-config with a server, without --safe-mode", { mcpServers: { probe: { command: "/bin/false" } } }],
  ];

  for (const [name, opts] of cases) {
    it(`accepts ${name}`, async () => {
      const probe = await probeClaudeCLI({ cwd: dir, ...opts });
      expect(probe.exitCode, probe.stderr).toBe(0);
      expect(probe.init).not.toBeNull();
    });
  }

  it("offers the built-in tools it is given and no others", async () => {
    const probe = await probeClaudeCLI({ cwd: dir, tools: ["Read", "Grep"] });
    const tools = probe.init!.tools as string[];
    expect(tools).toEqual(expect.arrayContaining(["Read", "Grep"]));
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Write");
  });
});

describe("conversations (a few low-effort model calls)", () => {
  const engine = () => new ClaudeEngine({ cwd: dir, effort: "low" });

  it("streams the reply as text deltas", async () => {
    const events: AgentEvent[] = [];
    for await (const event of engine().stream("Reply with exactly the word PONG.")) events.push(event);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    const result = events.find((e) => e.type === "result");
    expect(result && result.type === "result" ? result.text : "").toContain("PONG");
  });

  it("keeps the conversation across Session turns in one process", async () => {
    const session = engine().session();
    try {
      await session.send("Remember the word PELICAN. Reply with only OK.");
      const second = await session.send("What word did I ask you to remember? Reply with that word only.");
      expect(second.text.toUpperCase()).toContain("PELICAN");
    } finally {
      session.close();
    }
  });

  it("resumes a finished run by its session id", async () => {
    const first = await engine().run("Remember the word HERON. Reply with only OK.");
    expect(first.sessionId).not.toBe("");
    const second = await engine().run("What word did I ask you to remember? Reply with that word only.", {
      resume: first.sessionId,
    });
    expect(second.text.toUpperCase()).toContain("HERON");
  });

  it("asks the permission handler before a write and honours a denial", async () => {
    const asked: ToolRequest[] = [];
    await engine().run(
      "Use the Write tool to create a file named denied.txt in the current directory containing the word written. Then reply DONE.",
      {
        tools: ["Write"],
        onPermission: (request) => {
          asked.push(request);
          return { allow: false, message: "Denied by the CLI suite" };
        },
      },
    );
    expect(asked.map((r) => r.tool)).toContain("Write");
    expect(existsSync(join(dir, "denied.txt"))).toBe(false);
  });

  it("lets an approved write through", async () => {
    await engine().run(
      "Use the Write tool to create a file named allowed.txt in the current directory containing the word written. Then reply DONE.",
      { tools: ["Write"], onPermission: () => ({ allow: true }) },
    );
    expect(existsSync(join(dir, "allowed.txt"))).toBe(true);
    expect(readFileSync(join(dir, "allowed.txt"), "utf8")).toContain("written");
  });
});
