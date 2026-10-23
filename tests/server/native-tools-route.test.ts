import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "http";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { basename, dirname } from "path";
import { AgentError } from "../../src/errors.js";
import { requestFingerprint, recordFailure, failedAttempts } from "../../src/server/retry-notice.js";

const state = vi.hoisted(() => ({
  script: null as any,
  seen: [] as Array<{ kind: "run" | "stream"; prompt: string; options: any }>,
}));

vi.mock("../../src/server/engine-factory.js", () => ({
  makeEngine: () => ({
    run: async (prompt: string, options: any) => {
      state.seen.push({ kind: "run", prompt, options });
      return { text: "A plain answer.", cost: 0, duration: 0, sessionId: "", usage: { input_tokens: 1, output_tokens: 1 }, tools: [] };
    },
    stream: (prompt: string, options: any) => {
      state.seen.push({ kind: "stream", prompt, options });
      return state.script(prompt, options);
    },
  }),
}));

import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";

interface Reply { status: number; raw: string; complete: boolean; done: boolean; chunks: any[] }

function parseChunks(raw: string): any[] {
  return raw.split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

function postStream(base: string, body: unknown): Promise<Reply> {
  return new Promise((resolve) => {
    let settled = false;
    const req = http.request(new URL("/v1/chat/completions", base), {
      method: "POST", agent: false, headers: { "Content-Type": "application/json" },
    }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c) => parts.push(c));
      res.on("error", () => { /* reported through res.complete */ });
      const finish = () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(parts).toString();
        resolve({ status: res.statusCode!, raw, complete: res.complete, done: raw.includes("data: [DONE]"), chunks: raw.includes("data: ") ? parseChunks(raw) : [] });
      };
      res.on("end", finish);
      res.on("close", finish);
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      resolve({ status: 0, raw: "", complete: false, done: false, chunks: [] });
    });
    req.end(JSON.stringify(body));
  });
}

/** A dropped stream: no [DONE], and the response never completes. */
function expectDropped(r: Reply): void {
  expect(r.done).toBe(false);
  expect(r.raw).not.toContain("[DONE]");
  if (r.status !== 0) {
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
  }
}

/** A non-streamed POST: its status and parsed body. */
function postJson(base: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL("/v1/chat/completions", base), {
      method: "POST", agent: false, headers: { "Content-Type": "application/json" },
    }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(parts).toString();
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode!, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** A streamed POST whose client hangs up as soon as the first chunk arrives. */
function postAndHangUp(base: string, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(new URL("/v1/chat/completions", base), {
      method: "POST", agent: false, headers: { "Content-Type": "application/json" },
    }, (res) => {
      res.on("error", () => { /* the hang-up itself */ });
      res.once("data", () => { req.destroy(); resolve(); });
    });
    req.on("error", () => resolve());
    req.end(JSON.stringify(body));
  });
}

const isReasoning = (c: any) => c.choices?.[0]?.delta?.reasoning_content !== undefined;
const isContent = (c: any) => typeof c.choices?.[0]?.delta?.content === "string";
const isTool = (c: any) => !!c.choices?.[0]?.delta?.tool_calls;
const reasoningOf = (chunks: any[]) => chunks.filter(isReasoning).map((c) => c.choices[0].delta.reasoning_content as string);
const contentOf = (chunks: any[]) => chunks.filter(isContent).map((c) => c.choices[0].delta.content as string);
function toolCallsOf(chunks: any[]): Map<number, { first: any; args: string }> {
  const m = new Map<number, { first: any; args: string }>();
  for (const c of chunks) {
    for (const tc of c.choices?.[0]?.delta?.tool_calls ?? []) {
      const e = m.get(tc.index) ?? { first: tc, args: "" };
      e.args += tc.function?.arguments ?? "";
      m.set(tc.index, e);
    }
  }
  return m;
}

const WEATHER = {
  type: "function",
  function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
};
const READ = {
  type: "function",
  function: { name: "read_files", description: "Read files", parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } } },
};
const TOOLS = [WEATHER, READ];

/** A streamed request with client tools and a tool call in its history. `tag` makes its fingerprint unique. */
const body = (tag: string, over: Record<string, unknown> = {}) => ({
  model: "test-model",
  stream: true,
  tools: TOOLS,
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: `${tag}: weather in Paris?` },
    { role: "assistant", content: null, tool_calls: [{ id: "call_prev", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
    { role: "tool", tool_call_id: "call_prev", name: "get_weather", content: "Sunny" },
    { role: "user", content: "And Rome?" },
  ],
  ...over,
});
const call = (index: number, name: string, argumentsJson: string) => ({ type: "client_tool_call", index, id: `toolu_${index}`, name, argumentsJson });
const stop = (stopReason: string | null) => ({ type: "turn_stop", stopReason });
const result = (text = "") => ({ type: "result", text, cost: 0.01, duration: 5, sessionId: "", usage: { input_tokens: 7, output_tokens: 3 } });

/** The per-request directory of the last native run the mock engine saw. */
let lastDir = "";
const noteDir = (options: any): void => {
  const server = options?.mcpServers?.c?.args?.[0];
  if (typeof server === "string") lastDir = dirname(server);
};
const seq = (events: any[]) => async function* (_prompt: unknown, options: any) {
  noteDir(options);
  for (const e of events) yield e;
};
/** As seq, after writing a tools/call entry into the placeholder server's log. */
const reachingServer = (events: any[]) => async function* (_prompt: unknown, options: any) {
  noteDir(options);
  appendFileSync(options.mcpServers.c.args[2], JSON.stringify({
    at: "2026-01-01T00:00:00.000Z", pid: 1, event: "recv", method: "tools/call", id: 7, params: { name: "mcp__c__get_weather" },
  }) + "\n");
  for (const e of events) yield e;
};

async function gone(dir: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!existsSync(dir)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

let nativeServer: ApiServerHandle;
let plainServer: ApiServerHandle;
let nativeBase: string;
let plainBase: string;

beforeAll(async () => {
  nativeServer = await startApiServer({ port: 0, workingDir: "/tmp", verifyCli: false, nativeTools: true });
  nativeBase = `http://localhost:${(nativeServer.server.address() as { port: number }).port}`;
  plainServer = await startApiServer({ port: 0, workingDir: "/tmp", verifyCli: false });
  plainBase = `http://localhost:${(plainServer.server.address() as { port: number }).port}`;
});
afterAll(() => { nativeServer.close(); plainServer.close(); });

describe("R13 engine options for an eligible request", () => {
  it("runs the engine natively: dontAsk, one turn, only server c, the request's tools, the renamed history and no instruction", async () => {
    state.seen.length = 0;
    let toolsFile: unknown;
    state.script = async function* (_p: unknown, options: any) {
      noteDir(options);
      toolsFile = JSON.parse(readFileSync(options.mcpServers.c.args[1], "utf8"));
      yield call(0, "mcp__c__get_weather", '{"city":"Rome"}');
      yield stop("tool_use");
      yield result();
    };
    const r = await postStream(nativeBase, body("R13"));
    expect(r.done).toBe(true);
    expect(state.seen).toHaveLength(1);
    const { kind, prompt, options } = state.seen[0];
    expect(kind).toBe("stream");
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.maxTurns).toBe(1);
    expect(options.clientToolsNative).toEqual({ serverName: "c", toolNames: ["get_weather", "read_files"] });
    expect(Object.keys(options.mcpServers)).toEqual(["c"]);
    expect(options.mcpServers.c.type).toBe("stdio");
    expect(options.mcpServers.c.command).toBe(process.execPath);
    const args: string[] = options.mcpServers.c.args;
    expect(args.map((a) => basename(a))).toEqual(["server.mjs", "tools.json", "mcp.log.ndjson"]);
    expect(new Set(args.map((a) => dirname(a))).size).toBe(1);
    expect(basename(dirname(args[0]))).toMatch(/^otterly-native-/);
    expect(toolsFile).toEqual(TOOLS);
    expect(options.clientToolCalls).toBeUndefined();
    expect(options.systemPrompt).toBe("Be brief.");
    expect(options.model).toBe("test-model");
    expect(options.effort).toBe("medium");
    expect(options.structured429ForOpenAI).toBe(true);
    expect(options.cwd).toBe("/tmp");
    expect(prompt).toContain('[Previous assistant response]: called function(s) mcp__c__get_weather({"city":"Paris"})');
    expect(prompt).toContain("[Result of function mcp__c__get_weather]: Sunny");
    expect(prompt).not.toContain("=== REMINDER ===");
    expect(prompt).not.toContain("You can call the following functions");
    expect(prompt).not.toContain("=== USER REQUEST ===");
  });
});

describe("R14 the stream", () => {
  it("sends reasoning, then content, then one tool_calls entry per call, then tool_calls with usage and [DONE]", async () => {
    state.script = seq([
      { type: "thinking_delta", delta: "Planning." },
      { type: "text_delta", delta: "Checking " },
      { type: "text_delta", delta: "both." },
      { type: "text", text: "Checking both." },
      call(0, "mcp__c__get_weather", '{"city": "Rome"}'),
      call(1, "mcp__c__read_files", '{"paths": ["/a", "/b"]}'),
      stop("tool_use"),
      result(),
    ]);
    const r = await postStream(nativeBase, body("R14"));
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    expect(r.raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(reasoningOf(r.chunks)).toEqual(["Planning."]);
    expect(contentOf(r.chunks).join("")).toBe("Checking both.");
    const firstReasoning = r.chunks.findIndex(isReasoning);
    const firstContent = r.chunks.findIndex(isContent);
    const lastContent = r.chunks.map(isContent).lastIndexOf(true);
    const firstTool = r.chunks.findIndex(isTool);
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstContent);
    expect(lastContent).toBeLessThan(firstTool);
    const calls = toolCallsOf(r.chunks);
    expect([...calls.keys()]).toEqual([0, 1]);
    expect(calls.get(0)!.first.id).toMatch(/^call_/);
    expect(calls.get(1)!.first.id).toMatch(/^call_/);
    expect(calls.get(0)!.first.id).not.toBe(calls.get(1)!.first.id);
    expect(calls.get(0)!.first.type).toBe("function");
    expect(calls.get(0)!.first.function.name).toBe("get_weather");
    expect(calls.get(1)!.first.function.name).toBe("read_files");
    expect(JSON.parse(calls.get(0)!.args)).toEqual({ city: "Rome" });
    expect(JSON.parse(calls.get(1)!.args)).toEqual({ paths: ["/a", "/b"] });
    const last = r.chunks.at(-1);
    expect(last.choices[0].finish_reason).toBe("tool_calls");
    expect(last.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it("sends empty arguments as {}", async () => {
    state.script = seq([call(0, "mcp__c__read_files", ""), stop("tool_use"), result()]);
    const r = await postStream(nativeBase, body("R14 empty arguments"));
    expect(r.done).toBe(true);
    expect(JSON.parse(toolCallsOf(r.chunks).get(0)!.args)).toEqual({});
  });

  it("finishes a text-only turn with stop", async () => {
    state.script = seq([{ type: "text_delta", delta: "Rome is sunny." }, stop("end_turn"), result("Rome is sunny.")]);
    const r = await postStream(nativeBase, body("R14 prose"));
    expect(r.done).toBe(true);
    expect(contentOf(r.chunks).join("")).toBe("Rome is sunny.");
    expect(r.chunks.some(isTool)).toBe(false);
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });
});

describe("R15 name resolution and argument coercion on the route", () => {
  it("sends a plain-name call under its resolved name with paths coerced to an array, and mcp__c__y as y", async () => {
    state.script = seq([
      call(0, "read_files", '{"paths": "[\\"/a\\", \\"/b\\"]"}'),
      call(1, "mcp__c__y", '{"q": 1}'),
      stop("tool_use"),
      result(),
    ]);
    const r = await postStream(nativeBase, body("R15"));
    expect(r.done).toBe(true);
    const calls = toolCallsOf(r.chunks);
    expect(calls.get(0)!.first.function.name).toBe("read_files");
    expect(JSON.parse(calls.get(0)!.args)).toEqual({ paths: ["/a", "/b"] });
    expect(calls.get(1)!.first.function.name).toBe("y");
    expect(JSON.parse(calls.get(1)!.args)).toEqual({ q: 1 });
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("R16 the per-request directory", () => {
  it("no longer exists after a finished request", async () => {
    lastDir = "";
    state.script = seq([call(0, "mcp__c__get_weather", '{"city":"Rome"}'), stop("tool_use"), result()]);
    const r = await postStream(nativeBase, body("R16 finished"));
    expect(r.done).toBe(true);
    expect(lastDir).not.toBe("");
    expect(await gone(lastDir)).toBe(true);
  });

  it("no longer exists after a dropped request", async () => {
    lastDir = "";
    state.script = seq([call(0, "mcp__c__get_weather", '["Rome"]'), stop("tool_use"), result()]);
    const r = await postStream(nativeBase, body("R16 dropped"));
    expectDropped(r);
    expect(lastDir).not.toBe("");
    expect(await gone(lastDir)).toBe(true);
  });

  it("no longer exists after a request that ended in an in-stream error", async () => {
    lastDir = "";
    state.script = reachingServer([call(0, "mcp__c__get_weather", '{"city":"Rome"}'), stop("tool_use"), result()]);
    const r = await postStream(nativeBase, body("R16 in-stream error"));
    expect(r.done).toBe(true);
    expect(r.raw).toContain('"code":502');
    expect(lastDir).not.toBe("");
    expect(await gone(lastDir)).toBe(true);
  });
});

describe("R17 a tools/call that reached the placeholder server", () => {
  it("sends no tool_calls chunk, an in-stream error with code 502, then [DONE]", async () => {
    state.script = reachingServer([call(0, "mcp__c__get_weather", '{"city":"Rome"}'), stop("tool_use"), result()]);
    const r = await postStream(nativeBase, body("R17"));
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    expect(r.chunks.some(isTool)).toBe(false);
    const errorChunk = r.chunks.find((c) => c.error);
    expect(errorChunk.error.code).toBe(502);
    expect(r.raw.indexOf('"code":502')).toBeLessThan(r.raw.indexOf("data: [DONE]"));
  });
});

describe("R18 arguments that are not a JSON object", () => {
  it.each([
    ["a JSON array", '["Rome"]'],
    ["JSON that is cut short", '{"city": "Ro'],
  ])("drops the stream for %s, and the retry opens with an (attempt 2) notice", async (label, bad) => {
    let n = 0;
    state.script = (p: unknown, o: unknown) => {
      n++;
      return seq([call(0, "mcp__c__get_weather", n === 1 ? bad : '{"city":"Rome"}'), stop("tool_use"), result()])(p, o);
    };
    const b = body(`R18 ${label}`);
    const first = await postStream(nativeBase, b);
    expectDropped(first);
    const second = await postStream(nativeBase, b);
    expect(second.done).toBe(true);
    const notice = reasoningOf(second.chunks)[0];
    expect(notice).toContain("(attempt 2)");
    expect(notice).toContain("arguments that are not a JSON object");
    expect(second.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("R19 calls followed by a stop that is not tool_use", () => {
  it("ends with finish_reason length and sends no tool call when the turn stopped with max_tokens", async () => {
    state.script = seq([call(0, "mcp__c__get_weather", '{"city":"Rome"}'), stop("max_tokens"), result()]);
    const r = await postStream(nativeBase, body("R19"));
    expect(r.done).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.chunks.some(isTool)).toBe(false);
    expect(r.chunks.some((c) => c.error)).toBe(false);
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("length");
  });
});

describe("R20 no calls, and text showing tool-call intent", () => {
  it("drops the stream for <invoke name=\"mcp__c__get_weather\">", async () => {
    const text = 'Calling it now: <invoke name="mcp__c__get_weather"><parameter name="city">Rome</parameter></invoke>';
    state.script = seq([{ type: "text_delta", delta: text }, stop("end_turn"), result(text)]);
    const r = await postStream(nativeBase, body("R20"));
    expectDropped(r);
  });
});

describe("R21 fallbacks to the text-instruction path", () => {
  it.each<[string, () => string, Record<string, unknown>]>([
    ["a server started with the switch off", () => plainBase, body("R21 switch off")],
    ["stream false", () => nativeBase, body("R21 not streamed", { stream: false })],
    ["tool_choice required", () => nativeBase, body("R21 required", { tool_choice: "required" })],
    ["an ineligible tool name", () => nativeBase, body("R21 bad name", {
      tools: [{ type: "function", function: { name: "get.weather", parameters: { type: "object", properties: {} } } }],
    })],
  ])("takes today's path for %s", async (_label, baseOf, b) => {
    state.seen.length = 0;
    state.script = seq([{ type: "text_delta", delta: "A plain answer." }, result("A plain answer.")]);
    const r = await postStream(baseOf(), b);
    expect(r.status).toBe(200);
    expect(state.seen).toHaveLength(1);
    const { prompt, options } = state.seen[0];
    expect(options.clientToolCalls).toBe(true);
    expect(prompt).toContain("=== REMINDER ===");
    expect(options.clientToolsNative).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.permissionMode).toBe("bypassPermissions");
  });
});

describe("R22 a TOOL_ISOLATION failure from the engine", () => {
  it("sends an in-stream error with code 502, not a drop", async () => {
    lastDir = "";
    state.script = async function* (_p: unknown, options: any) {
      noteDir(options);
      yield { type: "thinking_delta", delta: "Thinking." };
      throw new AgentError("TOOL_ISOLATION", "Native client-tool isolation failed: test. The run was stopped.");
    };
    const r = await postStream(nativeBase, body("R22"));
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    expect(r.complete).toBe(true);
    const errorChunk = r.chunks.find((c) => c.error);
    expect(errorChunk.error.code).toBe(502);
    expect(r.chunks.some(isTool)).toBe(false);
    expect(await gone(lastDir)).toBe(true);
  });
});

const retried = (attempt: number | null) => ({ type: "turn_retry", attempt });

describe("N8 a CLI API retry before any reply text", () => {
  it("sends the reasoning with a retry line, then only the retried attempt's call, then tool_calls and [DONE]", async () => {
    state.script = seq([
      { type: "thinking_delta", delta: "Planning." },
      stop(null),
      retried(1),
      call(0, "mcp__c__get_weather", '{"city":"Rome"}'),
      stop("tool_use"),
      result(),
    ]);
    const r = await postStream(nativeBase, body("N8"));
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    const reasoning = reasoningOf(r.chunks).join("");
    expect(reasoning).toContain("Planning.");
    expect(reasoning).toContain("Claude Code retried it (retry 1)");
    expect(reasoning.indexOf("Planning.")).toBeLessThan(reasoning.indexOf("Claude Code retried it"));
    expect(r.chunks.some(isContent)).toBe(false);
    const calls = toolCallsOf(r.chunks);
    expect([...calls.keys()]).toEqual([0]);
    expect(calls.get(0)!.first.function.name).toBe("get_weather");
    expect(JSON.parse(calls.get(0)!.args)).toEqual({ city: "Rome" });
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(r.raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("leaves out (retry N) when the attempt is unknown", async () => {
    state.script = seq([retried(null), call(0, "mcp__c__get_weather", '{"city":"Rome"}'), stop("tool_use"), result()]);
    const r = await postStream(nativeBase, body("N8 no attempt"));
    expect(r.done).toBe(true);
    const reasoning = reasoningOf(r.chunks).join("");
    expect(reasoning).toContain("Claude Code retried it.");
    expect(reasoning).not.toContain("(retry");
  });
});

describe("N9 a CLI API retry after a call", () => {
  it("sends only the retried attempt's call", async () => {
    state.script = seq([
      call(0, "mcp__c__read_files", '{"paths": ["/a"]}'),
      retried(1),
      call(0, "mcp__c__get_weather", '{"city":"Rome"}'),
      stop("tool_use"),
      result(),
    ]);
    const r = await postStream(nativeBase, body("N9"));
    expect(r.done).toBe(true);
    const calls = toolCallsOf(r.chunks);
    expect([...calls.keys()]).toEqual([0]);
    expect(calls.get(0)!.first.function.name).toBe("get_weather");
    expect(JSON.parse(calls.get(0)!.args)).toEqual({ city: "Rome" });
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("N10 a CLI API retry after the reply had started", () => {
  it("drops the stream and stops the run, removes the per-request directory, and the retry opens with an (attempt 2) notice", async () => {
    let n = 0;
    let firstSignal: AbortSignal | undefined;
    let afterRetry = false;
    state.script = (p: unknown, o: any) => {
      n++;
      if (n === 1) {
        return (async function* () {
          noteDir(o);
          firstSignal = o.signal;
          yield { type: "text_delta", delta: "Checking " };
          yield retried(1);
          afterRetry = true;
          yield call(0, "mcp__c__get_weather", '{"city":"Rome"}');
          yield stop("tool_use");
          yield result();
        })();
      }
      return seq([call(0, "mcp__c__get_weather", '{"city":"Rome"}'), stop("tool_use"), result()])(p, o);
    };
    lastDir = "";
    const b = body("N10");
    const first = await postStream(nativeBase, b);
    expectDropped(first);
    expect(afterRetry).toBe(false);
    expect(firstSignal?.aborted).toBe(true);
    expect(lastDir).not.toBe("");
    expect(await gone(lastDir)).toBe(true);
    const second = await postStream(nativeBase, b);
    expect(second.done).toBe(true);
    const notice = reasoningOf(second.chunks)[0];
    expect(notice).toContain("(attempt 2)");
    expect(notice).toContain("interrupted by an Anthropic API retry");
    expect(second.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("N11 NATIVE_TURN_UNEXPECTED from the engine", () => {
  it("drops the stream rather than sending an in-stream error, and the retry opens with an (attempt 2) notice", async () => {
    let n = 0;
    state.script = (p: unknown, o: any) => {
      n++;
      if (n === 1) {
        return (async function* () {
          noteDir(o);
          yield { type: "thinking_delta", delta: "Thinking." };
          throw new AgentError("NATIVE_TURN_UNEXPECTED", "a second API message started with no API retry before it");
        })();
      }
      return seq([call(0, "mcp__c__get_weather", '{"city":"Rome"}'), stop("tool_use"), result()])(p, o);
    };
    const b = body("N11");
    const first = await postStream(nativeBase, b);
    expectDropped(first);
    expect(first.chunks.some((c) => c.error)).toBe(false);
    const second = await postStream(nativeBase, b);
    expect(second.done).toBe(true);
    const notice = reasoningOf(second.chunks)[0];
    expect(notice).toContain("(attempt 2)");
    expect(notice).toContain("produced output Otterly did not expect (a second API message started with no API retry before it)");
    expect(second.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("N12 TOOL_ISOLATION from the engine after a CLI API retry", () => {
  it("still sends an in-stream error with code 502 and [DONE], with no drop", async () => {
    lastDir = "";
    state.script = async function* (_p: unknown, options: any) {
      noteDir(options);
      yield retried(1);
      throw new AgentError("TOOL_ISOLATION", "Native client-tool isolation failed: test. The run was stopped.");
    };
    const r = await postStream(nativeBase, body("N12"));
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    expect(r.complete).toBe(true);
    const errorChunk = r.chunks.find((c) => c.error);
    expect(errorChunk.error.code).toBe(502);
    expect(r.raw.indexOf('"code":502')).toBeLessThan(r.raw.indexOf("data: [DONE]"));
    expect(r.chunks.some(isTool)).toBe(false);
    expect(await gone(lastDir)).toBe(true);
  });
});

const failing = () => seq([call(0, "mcp__c__get_weather", '["Rome"]'), stop("tool_use"), result()]);
const succeeding = () => seq([call(0, "mcp__c__get_weather", '{"city":"Rome"}'), stop("tool_use"), result()]);
const BAD_ARGS = "requested a tool with arguments that are not a JSON object";
const errorOf = (r: Reply) => r.chunks.find((c) => c.error)?.error;

describe("C1 the retry cap", () => {
  it("drops the first failure, ends the identical second with an in-stream error naming both reasons, and refuses the third without running it", async () => {
    state.script = failing();
    const b = body("C1 cap");
    expectDropped(await postStream(nativeBase, b));

    const second = await postStream(nativeBase, b);
    expect(second.status).toBe(200);
    expect(second.done).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.chunks.some(isTool)).toBe(false);
    const capped = errorOf(second);
    expect(capped.code).toBe(502);
    expect(capped.message).toBe(
      `Otterly stopped this request after 2 failed attempts. This attempt: ${BAD_ARGS}. The previous attempt: ${BAD_ARGS}. ` +
      "Nothing was run, and the request was not retried again; sending a new message continues.",
    );
    expect(second.raw.indexOf('{"error"')).toBeLessThan(second.raw.indexOf("data: [DONE]"));

    state.seen.length = 0;
    const third = await postStream(nativeBase, b);
    expect(third.status).toBe(200);
    expect(third.done).toBe(true);
    const refused = errorOf(third);
    expect(refused.code).toBe(400);
    expect(refused.message).toBe(
      `Otterly did not run this request: the identical request failed 2 times recently (last failure: ${BAD_ARGS}). ` +
      "It is not retried automatically. Sending a new message, or any change to the request, runs it.",
    );
    expect(state.seen).toHaveLength(0);
  });
});

describe("C2 a success clears the record", () => {
  it("drops the identical request again after a success in between, rather than capping it", async () => {
    let n = 0;
    state.script = (p: unknown, o: unknown) => (++n === 2 ? succeeding() : failing())(p, o);
    const b = body("C2 success resets");
    expectDropped(await postStream(nativeBase, b));
    const second = await postStream(nativeBase, b);
    expect(second.done).toBe(true);
    expect(second.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    const third = await postStream(nativeBase, b);
    expectDropped(third);
    expect(third.chunks.some((c) => c.error)).toBe(false);
  });
});

describe("C3 a client that hangs up", () => {
  it("does not count as a failed attempt", async () => {
    let n = 0;
    state.script = (p: unknown, o: any) => {
      n++;
      if (n !== 2) return failing()(p, o);
      return (async function* () {
        noteDir(o);
        yield { type: "thinking_delta", delta: "Thinking." };
        await new Promise<void>((resolve) => {
          if (o.signal.aborted) resolve();
          else o.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })();
    };
    const b = body("C3 disconnect");
    expectDropped(await postStream(nativeBase, b));
    expect(failedAttempts(requestFingerprint(b))).toBe(1);

    lastDir = "";
    await postAndHangUp(nativeBase, b);
    // The server has finished with the request once its directory is gone.
    for (let i = 0; i < 100 && lastDir === ""; i++) await new Promise((r) => setTimeout(r, 10));
    expect(lastDir).not.toBe("");
    expect(await gone(lastDir)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(failedAttempts(requestFingerprint(b))).toBe(1);

    // Still one failure: the next identical request runs, and is capped.
    state.seen.length = 0;
    const third = await postStream(nativeBase, b);
    expect(state.seen).toHaveLength(1);
    expect(errorOf(third).code).toBe(502);
  });
});

const cutOff = (usage: Record<string, unknown>, unfinishedCalls: string[] = []) => ({ type: "turn_stop", stopReason: "max_tokens", usage, unfinishedCalls });
const LIMIT_USAGE = { input_tokens: 5, output_tokens: 128000, output_tokens_details: { thinking_tokens: 116304 } };

describe("C4 a reply cut off at its output limit", () => {
  it("with calls: sends no tool call, ends the content with the note, then length with usage and [DONE], and reads nothing after the stop", async () => {
    let afterStop = false;
    state.script = async function* (_p: unknown, options: any) {
      noteDir(options);
      yield { type: "thinking_delta", delta: "Planning a lot." };
      yield call(0, "mcp__c__get_weather", '{"city":"Rome"}');
      yield cutOff(LIMIT_USAGE, ["mcp__c__read_files"]);
      afterStop = true;
      yield result();
    };
    const r = await postStream(nativeBase, body("C4 calls"));
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.chunks.some(isTool)).toBe(false);
    expect(r.chunks.some((c) => c.error)).toBe(false);
    expect(contentOf(r.chunks).join("")).toBe(
      "⚠️ Otterly: Claude's reply reached its output limit (128,000 output tokens, 116,304 of them thinking) and was stopped there. " +
      "The 2 tool calls it was writing (get_weather, read_files) were discarded, and nothing was run. " +
      "Otterly did not retry it, because the same request would stop the same way. " +
      "Ask for the work in smaller steps, or lower the reasoning effort.",
    );
    const last = r.chunks.at(-1);
    expect(last.choices[0].finish_reason).toBe("length");
    expect(last.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 128000, total_tokens: 128005 });
    expect(r.raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(afterStop).toBe(false);
  });

  it("with text only: keeps the text, then the note, then length", async () => {
    state.script = seq([{ type: "text_delta", delta: "Here is the first half" }, cutOff({ output_tokens: 128000 }), result()]);
    const r = await postStream(nativeBase, body("C4 text"));
    expect(r.done).toBe(true);
    const content = contentOf(r.chunks).join("");
    expect(content.startsWith(
      "Here is the first half\n\n⚠️ Otterly: Claude's reply reached its output limit (128,000 output tokens) and was stopped there. The reply above is incomplete.",
    )).toBe(true);
    expect(r.chunks.some(isTool)).toBe(false);
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("length");
  });

  it("while thinking only: the thinking note, then length", async () => {
    state.script = seq([{ type: "thinking_delta", delta: "Thinking." }, cutOff({ output_tokens: 128000, output_tokens_details: { thinking_tokens: 128000 } }), result()]);
    const r = await postStream(nativeBase, body("C4 thinking"));
    expect(r.done).toBe(true);
    const content = contentOf(r.chunks).join("");
    expect(content.startsWith("⚠️ Otterly: Claude's reply reached its output limit (128,000 output tokens, 128,000 of them thinking)")).toBe(true);
    expect(content).toContain("It spent the whole limit thinking and wrote nothing else.");
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("length");
  });

  it("is never retried: it clears the record, so the identical request after it runs normally, with no retry notice", async () => {
    let n = 0;
    state.script = (p: unknown, o: unknown) => {
      n++;
      if (n === 1) return failing()(p, o);
      if (n === 2) return seq([{ type: "text_delta", delta: "Partial" }, cutOff({ output_tokens: 128000 }), result()])(p, o);
      return succeeding()(p, o);
    };
    const b = body("C4 not retried");
    expectDropped(await postStream(nativeBase, b));
    const second = await postStream(nativeBase, b);
    expect(second.done).toBe(true);
    expect(second.chunks.some((c) => c.error)).toBe(false);
    expect(second.chunks.at(-1).choices[0].finish_reason).toBe("length");
    expect(failedAttempts(requestFingerprint(b))).toBe(0);
    const third = await postStream(nativeBase, b);
    expect(third.done).toBe(true);
    expect(third.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(reasoningOf(third.chunks).some((t) => t.includes("previous attempt"))).toBe(false);
  });
});

describe("C5 a non-streamed request whose identical request failed twice", () => {
  it("gets HTTP 400 and is not run", async () => {
    const b = body("C5 non-streamed", { stream: false });
    const fp = requestFingerprint(b);
    recordFailure(fp, "failed with HTTP 502");
    recordFailure(fp, "failed with HTTP 502");
    state.seen.length = 0;
    const r = await postJson(nativeBase, b);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(400);
    expect(r.body.error.message).toContain("Otterly did not run this request");
    expect(r.body.error.message).toContain("failed with HTTP 502");
    expect(state.seen).toHaveLength(0);
  });
});
