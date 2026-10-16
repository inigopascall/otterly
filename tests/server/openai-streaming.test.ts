import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "http";
import { AgentError } from "../../src/errors.js";
import { CliTerminatedError } from "../../src/engine.js";

const state = vi.hoisted(() => ({ script: null as any }));

vi.mock("../../src/server/engine-factory.js", () => ({
  makeEngine: () => ({
    run: async () => ({ text: "ok", cost: 0, usage: { input_tokens: 1, output_tokens: 1 } }),
    stream: (prompt: unknown, options: any) => state.script(prompt, options),
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
        resolve({ status: res.statusCode!, raw, complete: res.complete, done: raw.includes("data: [DONE]"), chunks: parseChunks(raw) });
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

const seq = (events: any[]) => async function* () { for (const e of events) yield e; };
const result = (text: string) => ({ type: "result", text, cost: 0, duration: 0, sessionId: "", usage: { input_tokens: 7, output_tokens: 3 } });
const deltas = (text: string, size = 7) => {
  const out: any[] = [];
  for (let i = 0; i < text.length; i += size) out.push({ type: "text_delta", delta: text.slice(i, i + size) });
  return out;
};

const TOOLS = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
const request = (content: string, tools = false) => ({
  model: "test-model", stream: true, messages: [{ role: "user", content }], ...(tools ? { tools: TOOLS } : {}),
});

const reasoningOf = (chunks: any[]) => chunks.filter((c) => c.choices?.[0]?.delta?.reasoning_content !== undefined).map((c) => c.choices[0].delta.reasoning_content as string);
const contentOf = (chunks: any[]) => chunks.filter((c) => typeof c.choices?.[0]?.delta?.content === "string").map((c) => c.choices[0].delta.content as string);
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
const firstIndex = (chunks: any[], pred: (c: any) => boolean) => chunks.findIndex(pred);

/**
 * A dropped stream. The server destroys the socket; when that happens before
 * its buffered writes are flushed, Node's http client reports a request error
 * ("socket hang up", status 0 here); otherwise it sees a 200 response that
 * never completes. Either way there is no [DONE].
 */
function expectDropped(r: Reply): void {
  expect(r.done).toBe(false);
  expect(r.raw).not.toContain("[DONE]");
  if (r.status !== 0) {
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
  }
}

let handle: ApiServerHandle;
let slow: ApiServerHandle;
let base: string;
let slowBase: string;

beforeAll(async () => {
  handle = await startApiServer({ port: 0, workingDir: "/tmp", verifyCli: false });
  base = `http://localhost:${(handle.server.address() as { port: number }).port}`;
  slow = await startApiServer({ port: 0, workingDir: "/tmp", streamTimeoutMs: 300, verifyCli: false });
  slowBase = `http://localhost:${(slow.server.address() as { port: number }).port}`;
});
afterAll(() => { handle.close(); slow.close(); });

describe("streamed chat completion without tools", () => {
  it("streams reasoning, then content, then stop with usage", async () => {
    state.script = seq([
      { type: "thinking_delta", delta: "Let me " },
      { type: "thinking_delta", delta: "think." },
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
      { type: "text", text: "Hello" },
      result("Hello"),
    ]);
    const r = await postStream(base, request("no-tools basic"));
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    expect(r.chunks[0].choices[0].delta.role).toBe("assistant");
    expect(reasoningOf(r.chunks)).toEqual(["Let me ", "think."]);
    expect(contentOf(r.chunks)).toEqual(["Hel", "lo"]);
    expect(firstIndex(r.chunks, (c) => c.choices[0].delta.reasoning_content !== undefined))
      .toBeLessThan(firstIndex(r.chunks, (c) => typeof c.choices[0].delta.content === "string"));
    const last = r.chunks.at(-1);
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    for (const c of r.chunks.slice(0, -1)) expect(c.choices[0].finish_reason).toBeNull();
  });
});

describe("streamed chat completion with tools", () => {
  it("streams a tool call after the reasoning", async () => {
    const env = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris","units":"metric"}}]}';
    state.script = seq([{ type: "thinking_delta", delta: "Planning." }, ...deltas(env), { type: "text", text: env }, result(env)]);
    const r = await postStream(base, request("tools envelope", true));
    expect(r.done).toBe(true);
    const firstReasoning = firstIndex(r.chunks, (c) => c.choices[0].delta.reasoning_content !== undefined);
    const firstTool = firstIndex(r.chunks, (c) => c.choices[0].delta.tool_calls);
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstTool);
    const calls = toolCallsOf(r.chunks);
    expect([...calls.keys()]).toEqual([0]);
    const call = calls.get(0)!;
    expect(call.first.id).toBeTruthy();
    expect(call.first.type).toBe("function");
    expect(call.first.function.name).toBe("get_weather");
    expect(JSON.parse(call.args)).toEqual({ city: "Paris", units: "metric" });
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(contentOf(r.chunks).join("")).not.toContain("tool_calls");
  });

  it("streams a prose reply as content and stops", async () => {
    state.script = seq([...deltas("Just an answer, no tool.", 5), result("Just an answer, no tool.")]);
    const r = await postStream(base, request("tools prose", true));
    expect(r.done).toBe(true);
    expect(contentOf(r.chunks).join("")).toBe("Just an answer, no tool.");
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(r.chunks.some((c) => c.choices[0].delta.tool_calls)).toBe(false);
  });

  it("drops a truncated envelope, then notices the retry once", async () => {
    const good = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}';
    const truncated = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Par';
    let n = 0;
    state.script = (p: unknown, o: unknown) => {
      n++;
      return n === 1 ? seq([...deltas(truncated), result(truncated)])() : seq([...deltas(good), result(good)])();
    };
    const body = request("tools truncated", true);

    const first = await postStream(base, body);
    expectDropped(first);
    expect(first.raw).not.toContain("[DONE]");

    const second = await postStream(base, body);
    expect(second.done).toBe(true);
    const notice = reasoningOf(second.chunks)[0];
    expect(notice).toContain("the previous attempt");
    expect(notice).toContain("(attempt 2)");
    expect(second.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");

    const third = await postStream(base, body);
    expect(third.done).toBe(true);
    expect(reasoningOf(third.chunks).some((t) => t.includes("previous attempt"))).toBe(false);
  });

  it("repairs an envelope missing one closing brace", async () => {
    const env = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]';
    state.script = seq([...deltas(env, 5), result(env)]);
    const r = await postStream(base, request("tools repairable", true));
    expect(r.done).toBe(true);
    expect(r.chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(JSON.parse(toolCallsOf(r.chunks).get(0)!.args)).toEqual({ city: "Paris" });
  });
});

describe("streamed failures after the headers", () => {
  it("drops the connection when the run goes idle", async () => {
    state.script = async function* () {
      yield { type: "text_delta", delta: "partial" };
      throw new AgentError("TIMEOUT", "No output", new CliTerminatedError("idle", "No output", { stdout: "", stderr: "", elapsedMs: 0 }));
    };
    const r = await postStream(base, request("idle drop"));
    expectDropped(r);
  });

  it("drops a native tool rejection for retry, and notices it on the retry", async () => {
    const good = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}';
    let n = 0;
    state.script = (p: unknown, o: unknown) => {
      n++;
      if (n === 1) {
        return (async function* () {
          yield { type: "thinking_delta", delta: "Thinking." };
          throw new AgentError("NATIVE_TOOL_CALL", "x");
        })();
      }
      return seq([...deltas(good), result(good)])();
    };
    const body = request("tools native tool rejection", true);

    const first = await postStream(base, body);
    expectDropped(first);
    expect(first.raw).not.toContain('"type":"server_error"');
    expect(first.raw).not.toContain('"code":502');

    const second = await postStream(base, body);
    expect(second.done).toBe(true);
    expect(reasoningOf(second.chunks)[0]).toContain("the previous attempt called one of Claude's own tools");
  });

  it("sends an in-stream timeout_error then [DONE] when the deadline fires", async () => {
    state.script = async function* (_p: unknown, options: any) {
      yield { type: "thinking_delta", delta: "Working." };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const r = await postStream(slowBase, request("deadline"));
    expect(r.status).toBe(200);
    expect(r.raw).toContain('"type":"timeout_error"');
    expect(r.done).toBe(true);
    expect(r.raw.indexOf('"type":"timeout_error"')).toBeLessThan(r.raw.indexOf("data: [DONE]"));
  });
});
