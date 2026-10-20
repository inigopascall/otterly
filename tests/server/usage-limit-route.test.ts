import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setQueryFnForTests, type QueryFn } from "../../src/engine.js";
import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";
import { quota, type QuotaDeps } from "../../src/server/quota.js";

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

  it("rechecks fresh /usage before rejecting inference, then serves without a probe once unblocked", async () => {
    const deps = (quota as unknown as { deps: QuotaDeps }).deps;
    const originalRun = deps.run;
    const originalFindCli = deps.findCli;
    let usageCalls = 0;
    deps.run = vi.fn(async (argv: string[]) => {
      if (argv[1] === "-p") {
        usageCalls++;
        return JSON.stringify({
          type: "assistant",
          usage_report: {
            rate_limits: {
              limits: [{
                kind: "session",
                percent: 4,
                resets_at: new Date(Date.now() + 7200000).toISOString(),
              }],
            },
          },
        }) + "\n";
      }
      return '{"loggedIn":false}';
    });
    deps.findCli = () => "/fake/claude";
    try {
      limitFor(7200);
      const first = await send(base, "POST", "/v1/chat/completions", CHAT);
      expect(first.status).toBe(200);
      expect(first.body.choices[0].message.content).toBe("Hello world");
      const quotaReply = await send(base, "GET", "/api/quota");
      expect(quotaReply.body.otterly.limited_until).toBeNull();
      expect(usageCalls).toBe(1);
      const second = await send(base, "POST", "/v1/chat/completions", CHAT);
      expect(second.status).toBe(200);
      expect(usageCalls).toBe(1);
      expect(queryCalls).toBe(2);
    } finally {
      deps.run = originalRun;
      deps.findCli = originalFindCli;
      quota.reset();
    }
  });

  it("fresh /usage through GET /api/quota lifts a seven_day block", async () => {
    const deps = (quota as unknown as { deps: QuotaDeps }).deps;
    const originalRun = deps.run;
    const originalFindCli = deps.findCli;
    let usageCalls = 0;
    deps.run = vi.fn(async (argv: string[]) => {
      if (argv[1] === "-p") {
        usageCalls++;
        return JSON.stringify({
          type: "assistant",
          usage_report: {
            rate_limits: {
              limits: [{
                kind: "weekly_all",
                percent: 64,
                resets_at: new Date(Date.now() + 7200000).toISOString(),
              }],
            },
          },
        }) + "\n";
      }
      return '{"loggedIn":false}';
    });
    deps.findCli = () => "/fake/claude";
    try {
      limitFor(7200, "seven_day");
      const quotaReply = await send(base, "GET", "/api/quota");
      expect(quotaReply.status).toBe(200);
      expect(quotaReply.body.otterly.limited_until).toBeNull();
      expect(usageCalls).toBe(1);
      const inference = await send(base, "POST", "/v1/chat/completions", CHAT);
      expect(inference.status).toBe(200);
      expect(usageCalls).toBe(1);
      expect(queryCalls).toBe(1);
    } finally {
      deps.run = originalRun;
      deps.findCli = originalFindCli;
      quota.reset();
    }
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


describe("the first usage-limit result from an HTTP route", () => {
  let handle: ApiServerHandle;
  let base = "";

  beforeAll(async () => {
    ({ handle, base } = await start());
  });

  afterAll(() => {
    handle.close();
  });

  function syntheticQuery(assistantText?: string): QueryFn {
    return () => {
      queryCalls++;
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "synthetic-session",
          model: "claude-sonnet-4-20250514",
          cwd: "/test",
          tools: [],
        };
        if (assistantText !== undefined) {
          yield { type: "assistant", message: { content: [{ type: "text", text: assistantText }] } };
        }
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 429,
          api_error: "usage_limit_reached",
          result: "opaque text unrelated to rate limits",
        };
      })();
    };
  }

  interface DroppedStream {
    status: number;
    body: string;
    requestError?: Error;
    responseError?: Error;
    ended: boolean;
    closed: boolean;
  }

  function sendStreamDropped(path: string, body: unknown): Promise<DroppedStream> {
    return new Promise((resolve) => {
      let settled = false;
      let status = 0;
      let requestError: Error | undefined;
      let responseError: Error | undefined;
      let ended = false;
      let closed = false;
      const chunks: Buffer[] = [];
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({
          status,
          body: Buffer.concat(chunks).toString(),
          requestError,
          responseError,
          ended,
          closed,
        });
      };
      const req = http.request(
        new URL(path, base),
        { method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          status = res.statusCode ?? 0;
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("error", (error) => {
            responseError = error;
            finish();
          });
          res.on("end", () => {
            ended = true;
          });
          res.on("close", () => {
            closed = true;
            finish();
          });
        },
      );
      req.on("error", (error) => {
        requestError = error;
        finish();
      });
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  function expectDroppedRateLimitStream(reply: DroppedStream): void {
    const dropped = reply.status === 0;
    const incomplete = reply.status === 200 && !reply.body.includes("[DONE]");
    expect(dropped || incomplete).toBe(true);
    expect(reply.body).not.toContain("finish_reason");
    expect(reply.body).not.toContain("[DONE]");
  }

  it("returns a structured 429 for a first usage-limit result without tools", async () => {
    setQueryFnForTests(syntheticQuery());
    try {
      const reply = await send(base, "POST", "/v1/chat/completions", { ...CHAT, stream: false });
      expect(reply.status).toBe(429);
      expect(reply.body).toMatchObject({ error: { type: "rate_limit_error" } });
      expect(reply.body.choices).toBeUndefined();
      expect(queryCalls).toBe(1);
    } finally {
      setQueryFnForTests(query);
      quota.reset();
    }
  });

  it("returns a structured 429 for a first usage-limit result with tools", async () => {
    setQueryFnForTests(syntheticQuery());
    try {
      const reply = await send(base, "POST", "/v1/chat/completions", {
        ...CHAT,
        stream: false,
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        }],
      });
      expect(reply.status).toBe(429);
      expect(reply.body).toMatchObject({ error: { type: "rate_limit_error" } });
      expect(reply.body.choices).toBeUndefined();
      expect(queryCalls).toBe(1);
    } finally {
      setQueryFnForTests(query);
      quota.reset();
    }
  });

  it("does not complete a normal stream after the first usage-limit result", async () => {
    setQueryFnForTests(syntheticQuery());
    try {
      const reply = await sendStreamDropped(base + "/v1/chat/completions", { ...CHAT, stream: true });
      expectDroppedRateLimitStream(reply);
      expect(queryCalls).toBe(1);
    } finally {
      setQueryFnForTests(query);
      quota.reset();
    }
  });

  it("does not complete a streamed tool request after the first usage-limit result", async () => {
    setQueryFnForTests(syntheticQuery());
    try {
      const reply = await sendStreamDropped(base + "/v1/chat/completions", {
        ...CHAT,
        stream: true,
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        }],
      });
      expectDroppedRateLimitStream(reply);
      expect(queryCalls).toBe(1);
    } finally {
      setQueryFnForTests(query);
      quota.reset();
    }
  });

  it("keeps a successful result at 200 when a rejected rate-limit event is recorded during it", async () => {
    const successfulQuery: QueryFn = () => {
      queryCalls++;
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "synthetic-session",
          model: "claude-sonnet-4-20250514",
          cwd: "/test",
          tools: [],
        };
        quota.recordRateLimitEvent({
          status: "rejected",
          resetsAt: Math.floor(Date.now() / 1000) + 7200,
          rateLimitType: "five_hour",
        });
        yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
        yield {
          type: "result",
          subtype: "success",
          result: "hello",
          total_cost_usd: 0.01,
          duration_ms: 1000,
          session_id: "synthetic-session",
          usage: { input_tokens: 10, output_tokens: 1 },
        };
      })();
    };
    setQueryFnForTests(successfulQuery);
    try {
      const reply = await send(base, "POST", "/v1/chat/completions", { ...CHAT, stream: false });
      expect(reply.status).toBe(200);
      expect(reply.body.choices[0].message.content).toBe("hello");
      expect(queryCalls).toBe(1);
    } finally {
      setQueryFnForTests(query);
      quota.reset();
    }
  });
});
