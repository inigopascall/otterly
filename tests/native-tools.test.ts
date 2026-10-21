import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  nativeToolsIneligible,
  resolveNativeToolName,
  coerceNativeArguments,
  nativeHistoryName,
  createNativeToolDir,
  removeNativeToolDir,
  countToolCallsReceived,
  NATIVE_MCP_SERVER_SOURCE,
} from "../src/server/native-tools.js";
import { openaiToClaudeInput, type OpenAIChatRequest } from "../src/server/openai-compat.js";
import { buildCLICommand, checkNativeInit } from "../src/engine.js";

const EMPTY_SCHEMA = { type: "object", properties: {} };
const fn = (name: string, parameters: Record<string, unknown> = EMPTY_SCHEMA) => ({ type: "function" as const, function: { name, parameters } });
const req = (over: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest => ({
  stream: true,
  messages: [{ role: "user", content: "hi" }],
  tools: [fn("get_weather")],
  ...over,
});

describe("R1 native-mode eligibility", () => {
  it("accepts a streamed request whose tool_choice is undefined", () => {
    expect(nativeToolsIneligible(req())).toBeNull();
  });

  it("accepts tool_choice auto", () => {
    expect(nativeToolsIneligible(req({ tool_choice: "auto" }))).toBeNull();
  });

  it("accepts a 56-character name and names with dashes and underscores", () => {
    expect(nativeToolsIneligible(req({ tools: [fn("a".repeat(56)), fn("read-files_2")] }))).toBeNull();
  });

  it.each<[string, OpenAIChatRequest]>([
    ["stream false", req({ stream: false })],
    ["tool_choice required", req({ tool_choice: "required" })],
    ["an object tool_choice", req({ tool_choice: { type: "function", function: { name: "get_weather" } } })],
    ["a 57-character name", req({ tools: [fn("a".repeat(57))] })],
    ["a name containing a dot", req({ tools: [fn("get.weather")] })],
    ["two tools with the same name", req({ tools: [fn("get_weather"), fn("get_weather")] })],
    ["a tool whose type is not function", req({ tools: [{ type: "web_search", function: { name: "search" } } as never] })],
    ["no tools", req({ tools: [] })],
  ])("rejects %s with a reason", (_label, body) => {
    const reason = nativeToolsIneligible(body);
    expect(typeof reason).toBe("string");
    expect((reason as string).length).toBeGreaterThan(0);
  });
});

describe("R2 call-name resolution", () => {
  const offered = new Set(["x"]);

  it("resolves mcp__c__x, with x offered, to x and not as a fix", () => {
    expect(resolveNativeToolName("mcp__c__x", offered)).toEqual({ name: "x", nameFixed: false, known: true });
  });

  it("accepts the offered plain name x, counted as a fix", () => {
    expect(resolveNativeToolName("x", offered)).toEqual({ name: "x", nameFixed: true, known: true });
  });

  it("forwards mcp__c__y, with y not offered, as y and unknown", () => {
    expect(resolveNativeToolName("mcp__c__y", offered)).toEqual({ name: "y", nameFixed: false, known: false });
  });

  it("forwards Bash as Bash and unknown", () => {
    expect(resolveNativeToolName("Bash", offered)).toEqual({ name: "Bash", nameFixed: false, known: false });
  });
});

describe("R3 argument coercion", () => {
  const params = {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" } },
      count: { type: "integer" },
      ratio: { type: "number" },
      query: { type: "string" },
    },
  };

  it("replaces a JSON-array string with the array where the schema says array, as a fix", () => {
    expect(coerceNativeArguments({ paths: '["/a","/b"]' }, params)).toEqual({ args: { paths: ["/a", "/b"] }, fixed: ["paths"] });
  });

  it("leaves 'not a list' where the schema says array as it is, not a fix", () => {
    expect(coerceNativeArguments({ paths: "not a list" }, params)).toEqual({ args: { paths: "not a list" }, fixed: [] });
  });

  it("replaces the string 5 with the number 5 where the schema says integer", () => {
    expect(coerceNativeArguments({ count: "5" }, params)).toEqual({ args: { count: 5 }, fixed: ["count"] });
  });

  it("accepts an integer where the schema says number", () => {
    expect(coerceNativeArguments({ ratio: "5" }, params)).toEqual({ args: { ratio: 5 }, fixed: ["ratio"] });
  });

  it("leaves a value that already has its type unchanged", () => {
    const args = { paths: ["/a"], count: 3, ratio: 0.5, query: "q" };
    expect(coerceNativeArguments(args, params)).toEqual({ args, fixed: [] });
  });

  it("leaves a property absent from the schema unchanged", () => {
    expect(coerceNativeArguments({ extra: "[1,2]" }, params)).toEqual({ args: { extra: "[1,2]" }, fixed: [] });
  });

  it("leaves JSON text in a string property unchanged", () => {
    expect(coerceNativeArguments({ query: '{"a":1}' }, params)).toEqual({ args: { query: '{"a":1}' }, fixed: [] });
  });

  it("leaves a JSON string of the wrong type unchanged", () => {
    expect(coerceNativeArguments({ count: '"five"' }, params)).toEqual({ args: { count: '"five"' }, fixed: [] });
  });
});

describe("R4 history renaming", () => {
  const body: OpenAIChatRequest = {
    messages: [
      { role: "user", content: "Weather in Paris?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "Sunny" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "other_tool", arguments: "{}" } }] },
      { role: "user", content: "Thanks" },
    ],
  };
  const today = [
    "Previous conversation context:",
    "Weather in Paris?",
    "",
    '[Previous assistant response]: called function(s) get_weather({"city":"Paris"})',
    "",
    "[Result of function get_weather]: Sunny",
    "",
    "[Previous assistant response]: called function(s) other_tool({})",
    "",
    "---",
    "",
    "Current message:",
    "Thanks",
  ].join("\n");
  const renamed = openaiToClaudeInput(body, { toolName: nativeHistoryName(["get_weather"]) }).prompt;

  it("renders a call to the offered get_weather as mcp__c__get_weather", () => {
    expect(renamed).toContain('[Previous assistant response]: called function(s) mcp__c__get_weather({"city":"Paris"})');
    expect(renamed).toContain("[Result of function mcp__c__get_weather]: Sunny");
  });

  it("leaves a name that is not offered unchanged", () => {
    expect(renamed).toContain("[Previous assistant response]: called function(s) other_tool({})");
    expect(renamed).not.toContain("mcp__c__other_tool");
  });

  it("renders today's output without the option", () => {
    expect(openaiToClaudeInput(body).prompt).toBe(today);
    expect(openaiToClaudeInput(body, {})).toEqual(openaiToClaudeInput(body));
  });
});

describe("R5 buildCLICommand in native mode", () => {
  const server = { type: "stdio", command: "/usr/bin/node", args: ["/tmp/x/server.mjs", "/tmp/x/tools.json", "/tmp/x/mcp.log.ndjson"] };
  const nativeOpts = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    permissionMode: "dontAsk",
    maxTurns: 1,
    mcpServers: { c: server },
    clientToolsNative: { serverName: "c", toolNames: ["get_weather"] },
    ...over,
  });
  const valueOf = (argv: string[], flag: string): string => {
    const i = argv.indexOf(flag);
    expect(i, flag).toBeGreaterThan(-1);
    return argv[i + 1];
  };

  it("passes each required flag with its value", () => {
    const argv = buildCLICommand("claude", nativeOpts({ model: "claude-test", effort: "low", systemPrompt: "Be brief." }));
    expect(valueOf(argv, "--tools")).toBe("");
    expect(valueOf(argv, "--setting-sources")).toBe("");
    expect(valueOf(argv, "--permission-mode")).toBe("dontAsk");
    expect(valueOf(argv, "--permission-prompts")).toBe("none");
    expect(valueOf(argv, "--max-turns")).toBe("1");
    for (const flag of ["--strict-mcp-config", "--restricted", "--disable-slash-commands", "--no-session-persistence", "--include-hook-events"]) {
      expect(argv).toContain(flag);
    }
    for (const flag of ["--tools", "--setting-sources", "--permission-mode", "--max-turns", "--mcp-config"]) {
      expect(argv.filter((a) => a === flag)).toHaveLength(1);
    }
    expect(valueOf(argv, "--model")).toBe("claude-test");
    expect(valueOf(argv, "--effort")).toBe("low");
    expect(valueOf(argv, "--system-prompt")).toBe("Be brief.");
    expect(argv).toContain("--include-partial-messages");
  });

  it("passes exactly the one server as --mcp-config", () => {
    const argv = buildCLICommand("claude", nativeOpts());
    expect(JSON.parse(valueOf(argv, "--mcp-config"))).toEqual({ mcpServers: { c: server } });
  });

  it("passes none of the forbidden flags", () => {
    const argv = buildCLICommand("claude", nativeOpts());
    for (const flag of ["--safe-mode", "--disallowedTools", "--permission-prompt-tool", "--allowedTools"]) {
      expect(argv).not.toContain(flag);
    }
    expect(argv).not.toContain("bypassPermissions");
  });

  it("accepts an empty tools list", () => {
    expect(() => buildCLICommand("claude", nativeOpts({ tools: [] }))).not.toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ["two MCP servers", { mcpServers: { c: server, d: server } }],
    ["one server with another name", { mcpServers: { d: server } }],
    ["no MCP server", { mcpServers: {} }],
    ["built-in tools", { tools: ["Read"] }],
    ["permissionMode bypassPermissions", { permissionMode: "bypassPermissions" }],
    ["permissionMode unset", { permissionMode: undefined }],
    ["maxTurns 2", { maxTurns: 2 }],
    ["maxTurns unset", { maxTurns: undefined }],
    ["canUseTool", { canUseTool: () => ({}) }],
    ["allowedTools", { allowedTools: ["mcp__c__get_weather"] }],
    ["disallowedTools", { disallowedTools: ["Bash"] }],
    ["resume", { resume: "session-1" }],
  ])("throws for %s", (_label, over) => {
    expect(() => buildCLICommand("claude", nativeOpts(over))).toThrow();
  });

  it("leaves the command without clientToolsNative unchanged", () => {
    expect(buildCLICommand("claude", { permissionMode: "bypassPermissions", maxTurns: 1 })).toEqual([
      "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--thinking-display", "summarized",
      "--system-prompt", "You are a helpful assistant.",
      "--setting-sources", "",
      "--tools", "",
      "--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--disallowedTools", "*",
      "--max-turns", "1",
      "--permission-mode", "bypassPermissions",
    ]);
  });
});

/** Spawn a request's placeholder server as the CLI would, and talk to it over stdio. */
function startPlaceholder(tools: unknown[]) {
  const files = createNativeToolDir(tools);
  const server = files.mcpServers.c as { command: string; args: string[] };
  const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (message: any) => void>();
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const request = (id: number, method: string, params: unknown = {}): Promise<any> => new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method: string): void => {
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  };
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { files, child, request, notify, exited };
}

describe("R6 the placeholder MCP server", () => {
  const tools = [
    fn("get_weather", { type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
    fn("read_files", { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } }),
  ];

  it("writes server.mjs and the request's tools.json into a private directory, which removeNativeToolDir removes", () => {
    const files = createNativeToolDir(tools);
    try {
      expect(readFileSync(files.serverPath, "utf8")).toBe(NATIVE_MCP_SERVER_SOURCE);
      expect(JSON.parse(readFileSync(files.toolsPath, "utf8"))).toEqual(tools);
      expect(files.mcpServers).toEqual({ c: { type: "stdio", command: process.execPath, args: [files.serverPath, files.toolsPath, files.logPath] } });
    } finally {
      removeNativeToolDir(files.dir);
    }
    expect(existsSync(files.dir)).toBe(false);
  });

  it("answers initialize and tools/list, refuses and logs tools/call, and countToolCallsReceived is then 1", async () => {
    const s = startPlaceholder(tools);
    try {
      const init = await s.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      expect(init.result.serverInfo).toMatchObject({ name: expect.any(String) });
      expect(init.result.protocolVersion).toBe("2025-06-18");
      s.notify("notifications/initialized");
      const list = await s.request(2, "tools/list");
      expect(list.result.tools.map((t: any) => t.name)).toEqual(["get_weather", "read_files"]);
      list.result.tools.forEach((t: any, i: number) => expect(t.inputSchema).toEqual(tools[i].function.parameters));
      expect(countToolCallsReceived(s.files.logPath)).toBe(0);
      const called = await s.request(3, "tools/call", { name: "get_weather", arguments: { city: "Paris" } });
      expect(called.result.isError).toBe(true);
      const logged = readFileSync(s.files.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(logged.some((e) => e.event === "recv" && e.method === "tools/call")).toBe(true);
      expect(countToolCallsReceived(s.files.logPath)).toBe(1);
    } finally {
      s.child.kill();
      removeNativeToolDir(s.files.dir);
    }
  }, 15000);

  it("exits when its stdin ends", async () => {
    const s = startPlaceholder(tools);
    try {
      await s.request(1, "initialize", {});
      s.child.stdin!.end();
      expect(await s.exited).toBe(0);
    } finally {
      s.child.kill();
      removeNativeToolDir(s.files.dir);
    }
  }, 15000);

  it("keeps answering after its directory has been removed", async () => {
    const s = startPlaceholder(tools);
    try {
      await s.request(1, "initialize", {});
      removeNativeToolDir(s.files.dir);
      const list = await s.request(2, "tools/list");
      expect(list.result.tools).toHaveLength(2);
      s.child.stdin!.end();
      expect(await s.exited).toBe(0);
    } finally {
      s.child.kill();
      removeNativeToolDir(s.files.dir);
    }
  }, 15000);
});

describe("R6 countToolCallsReceived", () => {
  const dir = mkdtempSync(join(tmpdir(), "otterly-native-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const entry = (e: Record<string, unknown>) => JSON.stringify({ at: "2026-01-01T00:00:00.000Z", pid: 1, ...e });

  it("is 0 for a log holding only the start, initialize and tools/list entries", () => {
    const path = join(dir, "clean.ndjson");
    writeFileSync(path, [
      entry({ event: "start", toolCount: 1 }),
      entry({ event: "recv", method: "initialize", id: 0 }),
      entry({ event: "recv", method: "notifications/initialized", id: null }),
      entry({ event: "recv", method: "tools/list", id: 1 }),
    ].join("\n") + "\n");
    expect(countToolCallsReceived(path)).toBe(0);
  });

  it("is 1 for a log holding one line that is not JSON", () => {
    const path = join(dir, "damaged.ndjson");
    writeFileSync(path, '{"event":"recv","meth\n');
    expect(countToolCallsReceived(path)).toBe(1);
  });

  it("counts each tools/call", () => {
    const path = join(dir, "calls.ndjson");
    writeFileSync(path, [
      entry({ event: "start", toolCount: 1 }),
      entry({ event: "recv", method: "tools/call", id: 2 }),
      entry({ event: "EXECUTION_REQUEST", name: "get_weather" }),
      entry({ event: "recv", method: "tools/call", id: 3 }),
    ].join("\n") + "\n");
    expect(countToolCallsReceived(path)).toBe(2);
  });

  it("is 0 for a missing log", () => {
    expect(countToolCallsReceived(join(dir, "absent.ndjson"))).toBe(0);
  });
});

describe("R7 checkNativeInit", () => {
  const expected = { serverName: "c", toolNames: ["get_weather", "read_files"] };
  const init = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "system",
    subtype: "init",
    cwd: "/work",
    session_id: "session-1",
    tools: ["mcp__c__get_weather", "mcp__c__read_files"],
    mcp_servers: [{ name: "c", status: "connected", source: "dynamic" }],
    model: "claude-test",
    permissionMode: "dontAsk",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "2.1.296",
    output_style: "default",
    agents: ["claude", "Explore"],
    skills: [],
    plugins: [{ name: "builtin-plugin", path: "builtin", source: "builtin-plugin@builtin" }],
    memory_paths: null,
    ...over,
  });

  it("accepts an init line shaped like the real one", () => {
    expect(checkNativeInit(init(), expected)).toBeNull();
  });

  it("accepts the tools in another order, and skills, slash_commands and memory_paths absent", () => {
    const line = init({ tools: ["mcp__c__read_files", "mcp__c__get_weather"] });
    delete line.skills;
    delete line.slash_commands;
    delete line.memory_paths;
    expect(checkNativeInit(line, expected)).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["an extra tool", { tools: ["mcp__c__get_weather", "mcp__c__read_files", "mcp__c__extra"] }],
    ["a missing tool", { tools: ["mcp__c__get_weather"] }],
    ["a built-in tool name such as Bash", { tools: ["mcp__c__get_weather", "Bash"] }],
    ["a duplicate in place of a missing tool", { tools: ["mcp__c__get_weather", "mcp__c__get_weather"] }],
    ["the server's status failed", { mcp_servers: [{ name: "c", status: "failed" }] }],
    ["two MCP servers", { mcp_servers: [{ name: "c", status: "connected" }, { name: "d", status: "connected" }] }],
    ["no MCP server", { mcp_servers: [] }],
    ["a server with another name", { mcp_servers: [{ name: "d", status: "connected" }] }],
    ["a non-empty skills", { skills: ["review"] }],
    ["a non-empty slash_commands", { slash_commands: ["compact"] }],
    ["a non-null memory_paths", { memory_paths: ["/work/CLAUDE.md"] }],
    ["permissionMode default", { permissionMode: "default" }],
    ["permissionMode absent", { permissionMode: undefined }],
  ])("rejects %s", (_label, over) => {
    expect(checkNativeInit(init(over), expected)).toEqual(expect.any(String));
  });
});
