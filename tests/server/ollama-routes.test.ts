import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import http from "http";

// Mock the SDK to emit a deterministic "Hello world" turn (same shape the real
// Claude Code SDK yields: partial text deltas plus a final assistant + result).
// `h.throwMid` makes the generator throw partway through to exercise the
// mid-stream error branch.
const h = vi.hoisted(() => ({ throwMid: false }));
vi.mock("@anthropic-ai/claude-code", () => ({
  query: vi.fn(() => (async function* () {
    yield { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-20250514", cwd: "/test", tools: [] };
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } };
    if (h.throwMid) throw new Error("boom mid-stream");
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } };
    yield { type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] } };
    yield { type: "result", subtype: "success", result: "Hello world", total_cost_usd: 0.01, duration_ms: 100, session_id: "s1", usage: { input_tokens: 10, output_tokens: 5 } };
  })()),
}));

afterEach(() => { h.throwMid = false; });

import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";

let handle: ApiServerHandle;
let baseUrl: string;

function req(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; contentType: string; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const r = http.request(url, { method: opts.method || "GET", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let body: any;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode!, contentType: res.headers["content-type"] || "", body, raw });
      });
    });
    r.on("error", reject);
    if (opts.body) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

describe("Ollama-native + model discovery routes", () => {
  beforeAll(async () => {
    handle = await startApiServer({ port: 0, workingDir: "/test" });
    baseUrl = `http://localhost:${(handle.server.address() as { port: number }).port}`;
  });
  afterAll(() => handle.close());

  describe("discovery", () => {
    it("GET /v1/models returns an OpenAI model list", async () => {
      const { status, body } = await req("/v1/models");
      expect(status).toBe(200);
      expect(body.object).toBe("list");
      expect(body.data.some((m: any) => m.id === "claude-sonnet-4-20250514")).toBe(true);
    });

    it("GET /api/tags returns models for auto-discovery", async () => {
      const { status, body } = await req("/api/tags");
      expect(status).toBe(200);
      expect(Array.isArray(body.models)).toBe(true);
      expect(body.models[0].name).toBeTruthy();
    });

    it("GET /api/version returns a version string", async () => {
      const { body } = await req("/api/version");
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("GET /api/ps returns an empty running-models list", async () => {
      const { body } = await req("/api/ps");
      expect(body.models).toEqual([]);
    });

    it("POST /api/show returns model metadata", async () => {
      const { status, body } = await req("/api/show", { method: "POST", body: { model: "claude-sonnet-4-20250514" } });
      expect(status).toBe(200);
      expect(body.model_info["claude.context_length"]).toBeGreaterThan(0);
      expect(body.capabilities).toContain("tools");
    });

    it("POST /api/pull reports success (non-stream)", async () => {
      const { status, body } = await req("/api/pull", { method: "POST", body: { model: "x", stream: false } });
      expect(status).toBe(200);
      expect(body.status).toBe("success");
    });
  });

  describe("POST /api/chat", () => {
    it("non-streaming returns a done message", async () => {
      const { status, body } = await req("/api/chat", {
        method: "POST",
        body: { model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "Hi" }], stream: false },
      });
      expect(status).toBe(200);
      expect(body.done).toBe(true);
      expect(body.message.role).toBe("assistant");
      expect(body.message.content).toBe("Hello world");
      expect(body.eval_count).toBe(5);
    });

    it("streaming returns NDJSON ending with done:true and no duplicated text", async () => {
      const { contentType, raw } = await req("/api/chat", {
        method: "POST",
        body: { messages: [{ role: "user", content: "Hi" }] }, // stream defaults to true
      });
      expect(contentType).toContain("application/x-ndjson");
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      const content = lines.filter((l) => !l.done).map((l) => l.message.content).join("");
      expect(content).toBe("Hello world"); // deltas only, full-text block skipped
      expect(lines[lines.length - 1].done).toBe(true);
    });
  });

  describe("POST /api/generate", () => {
    it("non-streaming returns a response field", async () => {
      const { status, body } = await req("/api/generate", {
        method: "POST",
        body: { model: "claude-sonnet-4-20250514", prompt: "Hi", stream: false },
      });
      expect(status).toBe(200);
      expect(body.done).toBe(true);
      expect(body.response).toBe("Hello world");
    });

    it("rejects a missing prompt", async () => {
      const { status, body } = await req("/api/generate", { method: "POST", body: { stream: false } });
      expect(status).toBe(400);
      expect(body.error).toBeTruthy();
    });
  });

  describe("mid-stream failure", () => {
    it("emits a terminating error line instead of hanging the NDJSON socket", async () => {
      h.throwMid = true;
      const { raw } = await req("/api/chat", { method: "POST", body: { messages: [{ role: "user", content: "Hi" }] } });
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      // Stream must terminate with a parseable error line, not a dangling socket.
      expect(lines[lines.length - 1].error).toContain("boom");
    });
  });
});

describe("Ollama routes — auth", () => {
  let authHandle: ApiServerHandle;
  let authUrl: string;

  beforeAll(async () => {
    process.env.OTTERLY_API_KEY = "sekret";
    authHandle = await startApiServer({ port: 0, workingDir: "/test" });
    authUrl = `http://localhost:${(authHandle.server.address() as { port: number }).port}`;
  });
  afterAll(() => { delete process.env.OTTERLY_API_KEY; authHandle.close(); });

  function call(path: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const r = http.request(new URL(path, authUrl), { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode!));
      });
      r.on("error", reject);
      r.write(JSON.stringify(body));
      r.end();
    });
  }

  it("gates /api/chat behind the API key", async () => {
    expect(await call("/api/chat", { messages: [{ role: "user", content: "Hi" }], stream: false })).toBe(401);
    expect(await call("/api/chat", { messages: [{ role: "user", content: "Hi" }], stream: false }, { Authorization: "Bearer sekret" })).toBe(200);
  });

  it("keeps discovery (/api/tags) public even with auth enabled", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request(new URL("/api/tags", authUrl), { method: "GET" }, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode!));
      });
      r.on("error", reject);
      r.end();
    });
    expect(status).toBe(200);
  });
});
