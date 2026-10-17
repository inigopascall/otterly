import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setQueryFnForTests, type QueryFn } from "../../src/engine.js";
import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";
import { quota } from "../../src/server/quota.js";

// The usage limit (quota.ts, index.ts): while the latest rate_limit_event is
// rejected, the routes that start the claude CLI answer HTTP 429 at once. The
// CLI is a fake that counts its runs. CLAUDE_CONFIG_DIR points at an empty
// directory for the whole file, and the test configuration hides the claude
// CLI, so GET /api/quota runs no command.

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
let configDir = "";
let queryCalls = 0;

const query: QueryFn = () => {
  queryCalls++;
  return (async function* () {
    yield {
      type: "system",
      subtype: "init",
      session_id: "test-session",
      model: "claude-sonnet-4-20250514",
      cwd: "/test",
      tools: ["Read"],
    };
    yield {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello world" } },
    };
    yield { type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] } };
    yield {
      type: "result",
      subtype: "success",
      result: "Hello world",
      total_cost_usd: 0.01,
      duration_ms: 1000,
      session_id: "test-session",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  })();
};

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "otterly-usage-limit-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  setQueryFnForTests(query);
});

afterAll(() => {
  setQueryFnForTests(null);
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  quota.reset();
  queryCalls = 0;
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function send(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, base),
      { method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode!, headers: res.headers, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function start(opts: { requestsPerMinute?: number } = {}): Promise<{ handle: ApiServerHandle; base: string }> {
  const handle = await startApiServer({ port: 0, workingDir: "/test", verifyCli: false, ...opts });
  const { port } = handle.server.address() as { port: number };
  return { handle, base: `http://localhost:${port}` };
}

/** Record a rejected rate_limit_event whose window resets `seconds` from now.
 *  Returns its resetsAt, in epoch seconds. */
function limitFor(seconds: number, rateLimitType = "five_hour"): number {
  const resetsAt = Math.floor(Date.now() / 1000) + seconds;
  quota.recordRateLimitEvent({ status: "rejected", resetsAt, rateLimitType });
  return resetsAt;
}

function limitMessage(type: string, resetsAt: number): string {
  return `Claude usage limit reached (${type}); resets at ${new Date(resetsAt * 1000).toISOString()}.`;
}

function expectRetryAfter(headers: http.IncomingHttpHeaders, min: number, max: number): void {
  expect(headers["retry-after"]).toMatch(/^\d+$/);
  expect(Number(headers["retry-after"])).toBeGreaterThanOrEqual(min);
  expect(Number(headers["retry-after"])).toBeLessThanOrEqual(max);
}

const CHAT = { model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "Hello" }] };
const NATIVE: Array<[string, unknown]> = [
  ["/api/run", { prompt: "Hello" }],
  ["/api/stream", { prompt: "Hello" }],
  ["/api/chat", { ...CHAT, stream: false }],
  ["/api/generate", { model: CHAT.model, prompt: "Hello", stream: false }],
];

describe("the usage limit", () => {
  let handle: ApiServerHandle;
  let base = "";

  beforeAll(async () => {
    ({ handle, base } = await start());
  });

  afterAll(() => {
    handle.close();
  });

  it("answers POST /v1/chat/completions with 429, Retry-After and an OpenAI error body", async () => {
    const resetsAt = limitFor(7200);
    const { status, headers, body } = await send(base, "POST", "/v1/chat/completions", CHAT);
    expect(status).toBe(429);
    expectRetryAfter(headers, 7199, 7200);
    expect(body).toEqual({
      error: { message: limitMessage("five_hour", resetsAt), type: "rate_limit_error", code: 429 },
    });
  });

  it("answers a streamed chat completion the same way", async () => {
    const resetsAt = limitFor(7200);
    const { status, headers, body } = await send(base, "POST", "/v1/chat/completions", { ...CHAT, stream: true });
    expect(status).toBe(429);
    expect(headers["content-type"]).toBe("application/json");
    expectRetryAfter(headers, 7199, 7200);
    expect(body).toEqual({
      error: { message: limitMessage("five_hour", resetsAt), type: "rate_limit_error", code: 429 },
    });
  });

  it.each(NATIVE)("answers POST %s with 429, Retry-After and {error}", async (path, payload) => {
    const resetsAt = limitFor(7200, "seven_day");
    const { status, headers, body } = await send(base, "POST", path, payload);
    expect(status).toBe(429);
    expectRetryAfter(headers, 7199, 7200);
    expect(body).toEqual({ error: limitMessage("seven_day", resetsAt) });
  });

  it("names the window unknown and holds 5 minutes when the event gives neither", async () => {
    quota.recordRateLimitEvent({ status: "rejected" });
    const { status, headers, body } = await send(base, "POST", "/v1/chat/completions", CHAT);
    expect(status).toBe(429);
    expectRetryAfter(headers, 299, 300);
    expect(body.error.message).toMatch(
      /^Claude usage limit reached \(unknown\); resets at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/,
    );
  });

  it("never starts the CLI", async () => {
    limitFor(7200);
    for (const [path, payload] of [["/v1/chat/completions", CHAT], ...NATIVE] as Array<[string, unknown]>) {
      expect((await send(base, "POST", path, payload)).status).toBe(429);
    }
    expect(queryCalls).toBe(0);
  });

  it("leaves the circuit breaker closed", async () => {
    limitFor(7200);
    for (let i = 0; i < 8; i++) {
      expect((await send(base, "POST", "/v1/chat/completions", CHAT)).status).toBe(429);
    }
    const { status, body } = await send(base, "GET", "/api/status");
    expect(status).toBe(200);
    expect(body.circuitBreaker).toBe("closed");
  });

  it("serves again at once after a later allowed event", async () => {
    limitFor(7200);
    expect((await send(base, "POST", "/v1/chat/completions", CHAT)).status).toBe(429);
    quota.recordRateLimitEvent({ status: "allowed", resetsAt: Math.floor(Date.now() / 1000) + 7200, rateLimitType: "five_hour" });
    const { status, body } = await send(base, "POST", "/v1/chat/completions", CHAT);
    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(queryCalls).toBe(1);
  });

  it("serves again once the reset time has passed", async () => {
    limitFor(-1);
    const { status } = await send(base, "POST", "/v1/chat/completions", CHAT);
    expect(status).toBe(200);
    expect(queryCalls).toBe(1);
  });

  it("reports limited_until in GET /api/quota while limited, and null otherwise", async () => {
    let { status, body } = await send(base, "GET", "/api/quota");
    expect(status).toBe(200);
    expect(body.otterly.limited_until).toBeNull();
    const resetsAt = limitFor(7200);
    ({ status, body } = await send(base, "GET", "/api/quota"));
    expect(status).toBe(200);
    expect(body.otterly).toMatchObject({ status: "rejected", limited_until: new Date(resetsAt * 1000).toISOString() });
    quota.recordRateLimitEvent({ status: "allowed" });
    ({ body } = await send(base, "GET", "/api/quota"));
    expect(body.otterly.limited_until).toBeNull();
  });
});

describe("the usage limit and the rate limiter", () => {
  let handle: ApiServerHandle;
  let base = "";

  beforeAll(async () => {
    ({ handle, base } = await start({ requestsPerMinute: 2 }));
  });

  afterAll(() => {
    handle.close();
  });

  it("answers before the rate limiter, so limited requests use none of its tokens", async () => {
    limitFor(7200);
    for (let i = 0; i < 3; i++) {
      const { status, body } = await send(base, "POST", "/v1/chat/completions", CHAT);
      expect(status).toBe(429);
      expect(body.error.message).toMatch(/^Claude usage limit reached/);
    }
    quota.recordRateLimitEvent({ status: "allowed" });
    expect((await send(base, "POST", "/v1/chat/completions", CHAT)).status).toBe(200);
  });
});

describe("the usage limit with OTTERLY_API_KEY set", () => {
  let handle: ApiServerHandle;
  let base = "";

  beforeAll(async () => {
    process.env.OTTERLY_API_KEY = "limit-secret";
    ({ handle, base } = await start());
  });

  afterAll(() => {
    delete process.env.OTTERLY_API_KEY;
    handle.close();
  });

  it("answers 401 without the bearer token, even while limited", async () => {
    limitFor(7200);
    const openai = await send(base, "POST", "/v1/chat/completions", CHAT);
    expect(openai.status).toBe(401);
    expect(openai.headers["retry-after"]).toBeUndefined();
    expect(openai.body).toEqual({ error: { message: "Invalid API key", type: "authentication_error", code: 401 } });
    const native = await send(base, "POST", "/api/run", { prompt: "Hello" });
    expect(native.status).toBe(401);
    expect(native.body).toEqual({ error: "Invalid API key" });
  });

  it("answers 429 with the bearer token", async () => {
    limitFor(7200);
    const { status, headers } = await send(base, "POST", "/v1/chat/completions", CHAT, {
      Authorization: "Bearer limit-secret",
    });
    expect(status).toBe(429);
    expectRetryAfter(headers, 7199, 7200);
    expect(queryCalls).toBe(0);
  });
});
