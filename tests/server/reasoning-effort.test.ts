import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "http";

const state = vi.hoisted(() => ({
  runs: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
  streams: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
}));

vi.mock("../../src/server/engine-factory.js", () => ({
  makeEngine: () => ({
    run: vi.fn(async (prompt: unknown, options: Record<string, unknown>) => {
      state.runs.push({ prompt, options });
      return { text: "ok", cost: 0, usage: { input_tokens: 1, output_tokens: 1 } };
    }),
    stream: vi.fn(async function* (prompt: unknown, options: Record<string, unknown>) {
      state.streams.push({ prompt, options });
      yield { type: "text", text: "ok" };
      yield { type: "result", text: "ok", cost: 0, usage: { input_tokens: 1, output_tokens: 1 } };
    }),
  }),
}));

import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";

let handle: ApiServerHandle;
let baseUrl: string;

function post(body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL("/v1/chat/completions", baseUrl), {
      method: "POST", headers: { "Content-Type": "application/json" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch { /* SSE or plain text */ }
        resolve({ status: res.statusCode!, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const request = (extra: Record<string, unknown> = {}) => ({
  model: "test-model", messages: [{ role: "user", content: "hi" }], ...extra,
});

describe("OpenAI reasoning_effort", () => {
  beforeAll(async () => {
    handle = await startApiServer({ port: 0, workingDir: "/tmp" });
    const address = handle.server.address() as { port: number };
    baseUrl = `http://localhost:${address.port}`;
  });
  afterAll(() => handle.close());

  it("defaults to medium for non-streaming, streaming, and tool requests", async () => {
    state.runs.length = 0;
    state.streams.length = 0;
    expect((await post(request())).status).toBe(200);
    expect((await post(request({ stream: true }))).status).toBe(200);
    expect((await post(request({ tools: [{ type: "function", function: { name: "f" } }] }))).status).toBe(200);
    expect(state.runs.map((call) => call.options.effort)).toEqual(["medium", "medium"]);
    expect(state.streams.map((call) => call.options.effort)).toEqual(["medium"]);
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("forwards valid effort %s", async (effort) => {
    state.runs.length = 0;
    expect((await post(request({ reasoning_effort: effort }))).status).toBe(200);
    expect(state.runs.at(-1)?.options.effort).toBe(effort);
  });

  it.each([["minimal", "low"], ["none", "low"]])("maps effort %s to %s", async (effort, expected) => {
    state.runs.length = 0;
    expect((await post(request({ reasoning_effort: effort }))).status).toBe(200);
    expect(state.runs.at(-1)?.options.effort).toBe(expected);
  });

  it.each(["bogus", "", null, 3, {}])("rejects invalid effort %j without calling the engine", async (effort) => {
    state.runs.length = 0;
    state.streams.length = 0;
    const response = await post(request({ reasoning_effort: effort }));
    expect(response.status).toBe(400);
    expect(state.runs).toHaveLength(0);
    expect(state.streams).toHaveLength(0);
  });
});
