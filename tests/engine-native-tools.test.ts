import { describe, it, expect } from "vitest";
import { ClaudeEngine, type QueryFn } from "../src/engine.js";
import { AgentError } from "../src/errors.js";
import type { AgentEvent, ClientToolCallEvent, EngineOptions } from "../src/types.js";

// Hand-written lines in the shapes the Claude CLI prints in a native
// client-tool run (stream-json with partial messages).

const NATIVE: EngineOptions = {
  permissionMode: "dontAsk",
  maxTurns: 1,
  mcpServers: { c: { type: "stdio", command: "node", args: ["server.mjs", "tools.json", "mcp.log.ndjson"] } },
  clientToolsNative: { serverName: "c", toolNames: ["read_files", "run_task"] },
};

type Line = Record<string, unknown>;

const init = (over: Line = {}): Line => ({
  type: "system",
  subtype: "init",
  cwd: "/work",
  session_id: "session-1",
  tools: ["mcp__c__read_files", "mcp__c__run_task"],
  mcp_servers: [{ name: "c", status: "connected", source: "dynamic" }],
  model: "claude-test",
  permissionMode: "dontAsk",
  slash_commands: [],
  skills: [],
  plugins: [],
  ...over,
});
const se = (event: Line): Line => ({ type: "stream_event", event, session_id: "session-1", parent_tool_use_id: null });
const messageStart = (): Line => se({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 1 } },
});
const blockStart = (index: number, content_block: Line): Line => se({ type: "content_block_start", index, content_block });
const toolStart = (index: number, id: string, name: string): Line => blockStart(index, { type: "tool_use", id, name, input: {}, caller: { type: "direct" } });
const delta = (index: number, d: Line): Line => se({ type: "content_block_delta", index, delta: d });
const jsonDelta = (index: number, partial_json: string): Line => delta(index, { type: "input_json_delta", partial_json });
const textDelta = (index: number, text: string): Line => delta(index, { type: "text_delta", text });
const thinkingDelta = (index: number, thinking: string): Line => delta(index, { type: "thinking_delta", thinking });
const blockStop = (index: number): Line => se({ type: "content_block_stop", index });
const messageDelta = (stop_reason: string): Line => se({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 99 } });
const messageStop = (): Line => se({ type: "message_stop" });
const assistantToolUse = (id: string, name: string, input: Line): Line => ({
  type: "assistant",
  message: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }], stop_reason: null },
  parent_tool_use_id: null,
  session_id: "session-1",
});
const toolResult = (id: string, isError: boolean): Line => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: "Permission to use this tool has been denied.", is_error: isError, tool_use_id: id }] },
  parent_tool_use_id: null,
  session_id: "session-1",
  tool_use_result: "Error: Permission to use this tool has been denied.",
});
const USAGE = { input_tokens: 2, cache_creation_input_tokens: 1132, cache_read_input_tokens: 0, output_tokens: 99 };
const maxTurnsResult = (): Line => ({
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  num_turns: 2,
  stop_reason: "tool_use",
  session_id: "session-1",
  total_cost_usd: 0.0123,
  duration_ms: 2100,
  usage: USAGE,
  permission_denials: [{ tool_name: "mcp__c__read_files", tool_use_id: "toolu_a" }, { tool_name: "mcp__c__run_task", tool_use_id: "toolu_b" }],
  terminal_reason: "max_turns",
  errors: ["Reached maximum number of turns (1)"],
});

// Call A's arguments hold a literal backslash-u escape, split mid-token. The
// assistant line shows it already turned into the character it names.
const BS = String.fromCharCode(92); // one backslash character
const A_FRAGMENTS = ["", '{"comm', `and": "printf '${BS}${BS}u20`, `19s'", "paths": ["/tmp/a.txt"]}`];
const B_FRAGMENTS = ["", '{"subagentId": "code-', `runner", "prompt": "Run ${BS}"ls`, `${BS}""}`];

const toolTurn = (): Line[] => [
  init(),
  { type: "system", subtype: "status", status: "requesting", session_id: "session-1" },
  messageStart(),
  blockStart(0, { type: "thinking", thinking: "" }),
  thinkingDelta(0, "Reading the "),
  thinkingDelta(0, "files."),
  blockStop(0),
  blockStart(1, { type: "text", text: "" }),
  textDelta(1, "Let me "),
  textDelta(1, "look."),
  blockStop(1),
  toolStart(2, "toolu_a", "mcp__c__read_files"),
  ...A_FRAGMENTS.map((f) => jsonDelta(2, f)),
  assistantToolUse("toolu_a", "mcp__c__read_files", { command: "printf '\u2019s'", paths: ["/tmp/a.txt"] }),
  { type: "system", subtype: "permission_denied", tool_name: "mcp__c__read_files", tool_use_id: "toolu_a", session_id: "session-1" },
  blockStop(2),
  toolResult("toolu_a", true),
  toolStart(3, "toolu_b", "mcp__c__run_task"),
  ...B_FRAGMENTS.map((f) => jsonDelta(3, f)),
  assistantToolUse("toolu_b", "mcp__c__run_task", { subagentId: "code-runner", prompt: 'Run "ls"' }),
  blockStop(3),
  toolResult("toolu_b", true),
  messageDelta("tool_use"),
  messageStop(),
  { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
  maxTurnsResult(),
];

const textTurn = (): Line[] => [
  init(),
  messageStart(),
  blockStart(0, { type: "text", text: "" }),
  textDelta(0, "Hello"),
  textDelta(0, " there."),
  blockStop(0),
  { type: "assistant", message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Hello there." }] }, session_id: "session-1" },
  messageDelta("end_turn"),
  messageStop(),
  { type: "result", subtype: "success", is_error: false, result: "Hello there.", total_cost_usd: 0.001, duration_ms: 900, session_id: "session-1", usage: { input_tokens: 5, output_tokens: 3 } },
];

interface FakeOpts {
  throwAfter?: Error;
  seen?: Array<Record<string, unknown>>;
  called?: { n: number };
}

function queryOf(lines: Line[], fake: FakeOpts = {}): QueryFn {
  return ({ options }) => {
    fake.seen?.push(options);
    if (fake.called) fake.called.n++;
    return (async function* () {
      for (const line of lines) yield line;
      if (fake.throwAfter) throw fake.throwAfter;
    })();
  };
}

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e) => e);
const callsOf = (events: AgentEvent[]) => events.filter((e): e is ClientToolCallEvent => e.type === "client_tool_call");
const deltasOf = (events: AgentEvent[], type: "text_delta" | "thinking_delta") =>
  events.filter((e) => e.type === type).map((e) => (e as { delta: string }).delta);

describe("R8 two parallel native tool calls", () => {
  it("yields each call with the concatenated input_json_delta fragments, then turn_stop, then the result", async () => {
    const events = await drain(new ClaudeEngine({}, queryOf(toolTurn())).stream("p", NATIVE));
    const calls = callsOf(events);
    expect(calls).toEqual([
      { type: "client_tool_call", index: 0, id: "toolu_a", name: "mcp__c__read_files", argumentsJson: A_FRAGMENTS.join("") },
      { type: "client_tool_call", index: 1, id: "toolu_b", name: "mcp__c__run_task", argumentsJson: B_FRAGMENTS.join("") },
    ]);
    // The arguments come from the fragments, not from the assistant line.
    expect(JSON.parse(calls[0].argumentsJson).command).toBe(`printf '${BS}u2019s'`);
    expect(JSON.parse(calls[0].argumentsJson).command).not.toBe(`printf '${String.fromCharCode(0x2019)}s'`);
    expect(JSON.parse(calls[1].argumentsJson)).toEqual({ subagentId: "code-runner", prompt: 'Run "ls"' });

    const stopAt = events.findIndex((e) => e.type === "turn_stop");
    expect(events[stopAt]).toEqual({ type: "turn_stop", stopReason: "tool_use" });
    expect(stopAt).toBeGreaterThan(events.indexOf(calls[1]));
    expect(events.at(-1)).toEqual({ type: "result", text: "", cost: 0.0123, duration: 2100, sessionId: "session-1", usage: USAGE });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(deltasOf(events, "thinking_delta")).toEqual(["Reading the ", "files."]);
    expect(deltasOf(events, "text_delta")).toEqual(["Let me ", "look."]);
  });

  it("forwards clientToolsNative to the query options", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await drain(new ClaudeEngine({}, queryOf(toolTurn(), { seen })).stream("p", NATIVE));
    expect(seen[0].clientToolsNative).toEqual(NATIVE.clientToolsNative);
    expect(seen[0].permissionMode).toBe("dontAsk");
    expect(seen[0].maxTurns).toBe(1);
  });
});

describe("R9 the CLI's exit after a tool turn", () => {
  it("ends the stream normally on claude exited 1: ... after a completed tool turn", async () => {
    const throwAfter = new Error("claude exited 1: Error: Reached maximum number of turns (1)");
    const events = await drain(new ClaudeEngine({}, queryOf(toolTurn(), { throwAfter })).stream("p", NATIVE));
    expect(callsOf(events)).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("result");
  });

  it("ends the stream normally on a bare claude exited 1 after a completed tool turn", async () => {
    const events = await drain(new ClaudeEngine({}, queryOf(toolTurn(), { throwAfter: new Error("claude exited 1") })).stream("p", NATIVE));
    expect(events.at(-1)?.type).toBe("result");
  });

  it.each([
    ["claude exited 2: Error"],
    ["claude exited 10: Error"],
  ])("throws %s after a tool turn", async (message) => {
    const err = await failure(drain(new ClaudeEngine({}, queryOf(toolTurn(), { throwAfter: new Error(message) })).stream("p", NATIVE)));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(message);
  });

  it("throws an AgentError whose message is claude exited 1 after a tool turn", async () => {
    const err = await failure(drain(new ClaudeEngine({}, queryOf(toolTurn(), { throwAfter: new AgentError("UNKNOWN", "claude exited 1") })).stream("p", NATIVE)));
    expect(err).toBeInstanceOf(AgentError);
  });

  it("throws claude exited 1: ... without a tool turn, as today", async () => {
    const lines = textTurn().slice(0, -1);
    const err = await failure(drain(new ClaudeEngine({}, queryOf(lines, { throwAfter: new Error("claude exited 1: boom") })).stream("p", NATIVE)));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("claude exited 1: boom");
  });

  it("throws claude exited 1: ... when the tool turn had no result line", async () => {
    const lines = toolTurn().slice(0, -1);
    const err = await failure(drain(new ClaudeEngine({}, queryOf(lines, { throwAfter: new Error("claude exited 1: boom") })).stream("p", NATIVE)));
    expect(err).toBeInstanceOf(Error);
  });
});

describe("R10 TOOL_ISOLATION", () => {
  const cases: Array<[string, Line[]]> = [
    ["an inventory mismatch", [init({ tools: ["mcp__c__read_files", "mcp__c__run_task", "Bash"] }), messageStart()]],
    ["a tool_result with is_error false", [
      init(), messageStart(), toolStart(0, "toolu_a", "mcp__c__read_files"), jsonDelta(0, '{"paths": []}'), blockStop(0), toolResult("toolu_a", false),
    ]],
    ["a second message_start", [init(), messageStart(), blockStart(0, { type: "text", text: "" }), textDelta(0, "Hi"), blockStop(0), messageStart()]],
    ["a content_block_start of type server_tool_use", [
      init(), messageStart(), blockStart(0, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
    ]],
  ];

  it.each(cases)("throws TOOL_ISOLATION and aborts the run for %s", async (_label, lines) => {
    const seen: Array<Record<string, unknown>> = [];
    const err = await failure(drain(new ClaudeEngine({}, queryOf([...lines, messageDelta("end_turn"), messageStop()], { seen })).stream("p", NATIVE)));
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("TOOL_ISOLATION");
    expect((seen[0].abortController as AbortController).signal.aborted).toBe(true);
  });
});

describe("R11 a text-only native turn", () => {
  it("yields its text deltas and a result, and no client_tool_call", async () => {
    const events = await drain(new ClaudeEngine({}, queryOf(textTurn())).stream("p", NATIVE));
    expect(deltasOf(events, "text_delta")).toEqual(["Hello", " there."]);
    expect(callsOf(events)).toHaveLength(0);
    expect(events.find((e) => e.type === "turn_stop")).toEqual({ type: "turn_stop", stopReason: "end_turn" });
    expect(events.at(-1)).toMatchObject({ type: "result", text: "Hello there." });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("R12 options that cannot be combined with clientToolsNative", () => {
  it.each<[string, EngineOptions]>([
    ["clientToolCalls", { ...NATIVE, clientToolCalls: true }],
    ["onPermission", { ...NATIVE, onPermission: () => ({ allow: false }) }],
  ])("throws for %s before the query function is called", async (_label, options) => {
    const called = { n: 0 };
    const err = await failure(drain(new ClaudeEngine({}, queryOf(toolTurn(), { called })).stream("p", options)));
    expect(err).toBeInstanceOf(Error);
    expect(called.n).toBe(0);
  });
});
