import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import http from "http";

// Mock the SDK so Claude "responds" with text we control per-test (a tool-call
// JSON, multiple calls, or plain prose). The route must parse tool calls back
// into OpenAI tool_calls, and fall back to a text turn otherwise.
const TOOL_JSON = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}';
const h = vi.hoisted(() => ({ result: '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}' }));
const seenOptions: any[] = [];

vi.mock("@anthropic-ai/claude-code", () => ({
  query: vi.fn(({ options }: any) => {
    seenOptions.push(options);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/test", tools: [] };
      yield { type: "assistant", message: { content: [{ type: "text", text: h.result }] } };
      yield { type: "result", subtype: "success", result: h.result, total_cost_usd: 0.01, duration_ms: 50, session_id: "s1", usage: { input_tokens: 8, output_tokens: 4 } };
    })();
  }),
}));

afterEach(() => { h.result = TOOL_JSON; });

import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";

let handle: ApiServerHandle;
let baseUrl: string;

function post(path: string, body: unknown): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const r = http.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode!, body: parsed, raw });
      });
    });
    r.on("error", reject);
    r.write(JSON.stringify(body));
    r.end();
  });
}

const WEATHER_TOOLS = [{
  type: "function",
  function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
}];

describe("OpenAI function calling (/v1/chat/completions with tools)", () => {
  beforeAll(async () => {
    handle = await startApiServer({ port: 0, workingDir: "/test" });
    baseUrl = `http://localhost:${(handle.server.address() as { port: number }).port}`;
  });
  afterAll(() => handle.close());

  it("returns OpenAI tool_calls with finish_reason tool_calls", async () => {
    const { status, body } = await post("/v1/chat/completions", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: WEATHER_TOOLS,
      stream: false,
    });
    expect(status).toBe(200);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.content).toBeNull();
    const call = body.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("get_weather");
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "Paris" });
  });

  it("disables Claude's own built-in tools when the client supplies tools", () => {
    const last = seenOptions[seenOptions.length - 1];
    expect(last.disallowedTools).toContain("Bash");
    expect(last.disallowedTools).toContain("Write");
  });

  it("streams the tool_calls as a terminal SSE chunk", async () => {
    const { raw } = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: WEATHER_TOOLS,
      stream: true,
    });
    expect(raw).toContain("data: [DONE]");
    const dataLines = raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
    const toolDelta = dataLines.find((d) => d.choices[0].delta.tool_calls);
    expect(toolDelta).toBeDefined();
    expect(toolDelta.choices[0].delta.tool_calls[0].function.name).toBe("get_weather");
    const finish = dataLines.find((d) => d.choices[0].finish_reason === "tool_calls");
    expect(finish).toBeDefined();
  });

  it("streams multiple parallel tool_calls with distinct indices", async () => {
    h.result = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}},{"name":"get_time","arguments":{"tz":"CET"}}]}';
    const { raw } = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "weather and time?" }],
      tools: WEATHER_TOOLS,
      stream: true,
    });
    const dataLines = raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
    const toolDelta = dataLines.find((d) => d.choices[0].delta.tool_calls);
    const calls = toolDelta.choices[0].delta.tool_calls;
    expect(calls).toHaveLength(2);
    expect(calls[0].index).toBe(0);
    expect(calls[1].index).toBe(1);
    expect(calls[0].function.name).toBe("get_weather");
    expect(calls[1].function.name).toBe("get_time");
  });

  it("streams a plain text turn when the model declines to call a tool", async () => {
    h.result = "I'll just answer directly: hello there.";
    const { raw } = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
      tools: WEATHER_TOOLS,
      stream: true,
    });
    const dataLines = raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
    const content = dataLines.map((d) => d.choices[0].delta.content).filter(Boolean).join("");
    expect(content).toContain("hello there");
    expect(dataLines.some((d) => d.choices[0].finish_reason === "stop")).toBe(true);
    expect(dataLines.some((d) => d.choices[0].delta.tool_calls)).toBe(false);
  });

  it("tool_choice:none keeps a normal text answer (no tool parsing)", async () => {
    const { body } = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
      tools: WEATHER_TOOLS,
      tool_choice: "none",
      stream: false,
    });
    // With tools suppressed, the route takes the plain path: the mock's text is
    // returned verbatim as content with finish_reason stop.
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.content).toBe(TOOL_JSON);
  });
});
