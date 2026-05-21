import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "http";

// Mock the SDK before importing server modules
vi.mock("@anthropic-ai/claude-code", () => ({
  query: vi.fn(({ prompt, options }: any) => {
    const promptStr = typeof prompt === "string" ? prompt : "mock";

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
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello " },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "world" },
        },
      };
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      };
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
  }),
}));

import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";

let handle: ApiServerHandle;
let baseUrl: string;

function fetch(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, {
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let body: any;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode!, body, raw });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

describe("API Server Routes", () => {
  beforeAll(async () => {
    handle = await startApiServer({ port: 0, workingDir: "/test" });
    const addr = handle.server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    handle.close();
  });

  describe("GET /api/status", () => {
    it("returns health check", async () => {
      const { status, body } = await fetch("/api/status");
      expect(status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(typeof body.activeSessions).toBe("number");
    });
  });

  describe("POST /v1/chat/completions (non-streaming)", () => {
    it("returns OpenAI-format response", async () => {
      const { status, body } = await fetch("/v1/chat/completions", {
        method: "POST",
        body: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Hello" }],
          stream: false,
        },
      });
      expect(status).toBe(200);
      expect(body.object).toBe("chat.completion");
      expect(body.id).toMatch(/^chatcmpl-otterly-/);
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.choices[0].message.content).toBe("Hello world");
      expect(body.choices[0].finish_reason).toBe("stop");
    });

    it("rejects missing messages", async () => {
      const { status, body } = await fetch("/v1/chat/completions", {
        method: "POST",
        body: {},
      });
      expect(status).toBe(400);
      expect(body.error.message).toBe("messages array is required");
    });
  });

  describe("POST /v1/chat/completions (streaming)", () => {
    it("returns SSE stream", async () => {
      const raw = await new Promise<string>((resolve, reject) => {
        const url = new URL("/v1/chat/completions", baseUrl);
        const req = http.request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toBe("text/event-stream");
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on("error", reject);
        req.write(JSON.stringify({
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }));
        req.end();
      });

      // Parse SSE lines
      const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
      expect(lines.length).toBeGreaterThanOrEqual(3); // role + content chunks + stop + [DONE]

      // First chunk should have role
      const first = JSON.parse(lines[0].replace("data: ", ""));
      expect(first.choices[0].delta.role).toBe("assistant");

      // Should end with [DONE]
      expect(raw).toContain("data: [DONE]");

      // Should have a stop chunk
      const stopLine = lines.find((l) => {
        try {
          const d = JSON.parse(l.replace("data: ", ""));
          return d.choices?.[0]?.finish_reason === "stop";
        } catch { return false; }
      });
      expect(stopLine).toBeDefined();
    });
  });

  describe("POST /api/run", () => {
    it("returns native result", async () => {
      const { status, body } = await fetch("/api/run", {
        method: "POST",
        body: { prompt: "Hello" },
      });
      expect(status).toBe(200);
      expect(body.text).toBe("Hello world");
      expect(body.cost).toBe(0.01);
      expect(body.duration).toBe(1000);
      expect(body.sessionId).toBe("test-session");
    });

    it("rejects missing prompt", async () => {
      const { status, body } = await fetch("/api/run", {
        method: "POST",
        body: {},
      });
      expect(status).toBe(400);
      expect(body.error).toBe("prompt is required");
    });
  });

  describe("POST /api/stream", () => {
    it("returns NDJSON stream", async () => {
      const raw = await new Promise<string>((resolve, reject) => {
        const url = new URL("/api/stream", baseUrl);
        const req = http.request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toBe("application/x-ndjson");
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on("error", reject);
        req.write(JSON.stringify({ prompt: "Hello" }));
        req.end();
      });

      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));

      // Should have session_init
      expect(lines.some((l) => l.type === "session_init")).toBe(true);

      // Should have text_delta events
      expect(lines.some((l) => l.type === "text_delta")).toBe(true);

      // Should end with result
      const result = lines.find((l) => l.type === "result");
      expect(result).toBeDefined();
      expect(result!.text).toBe("Hello world");
    });
  });

  describe("GET /", () => {
    it("returns server info JSON", async () => {
      const { status, body } = await fetch("/");
      expect(status).toBe(200);
      expect(body.name).toBe("otterly");
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(body.playground).toBe("/playground");
    });
  });

  describe("GET /playground", () => {
    it("returns HTML playground", async () => {
      const result = await new Promise<{ status: number; contentType: string; body: string }>((resolve, reject) => {
        const url = new URL("/playground", baseUrl);
        const req = http.request(url, { method: "GET" }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode!,
              contentType: res.headers["content-type"] || "",
              body: Buffer.concat(chunks).toString(),
            });
          });
        });
        req.on("error", reject);
        req.end();
      });

      expect(result.status).toBe(200);
      expect(result.contentType).toContain("text/html");
      expect(result.body).toContain("otterly playground");
      expect(result.body).toContain("<!DOCTYPE html>");
    });
  });

  describe("404", () => {
    it("returns 404 for unknown routes", async () => {
      const { status } = await fetch("/unknown");
      expect(status).toBe(404);
    });
  });

  describe("CORS", () => {
    it("handles OPTIONS preflight", async () => {
      const { status } = await fetch("/v1/chat/completions", { method: "OPTIONS" });
      expect(status).toBe(204);
    });
  });
});

describe("API Key Auth", () => {
  let authHandle: ApiServerHandle;
  let authBaseUrl: string;

  beforeAll(async () => {
    process.env.OTTERLY_API_KEY = "test-secret";
    authHandle = await startApiServer({ port: 0, workingDir: "/test" });
    const addr = authHandle.server.address() as { port: number };
    authBaseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    delete process.env.OTTERLY_API_KEY;
    authHandle.close();
  });

  function authFetch(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, authBaseUrl);
      const req = http.request(url, {
        method: opts.method || "POST",
        headers: {
          "Content-Type": "application/json",
          ...opts.headers,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let body: any;
          try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode!, body });
        });
      });
      req.on("error", reject);
      if (opts.body) req.write(JSON.stringify(opts.body));
      req.end();
    });
  }

  it("rejects requests without auth", async () => {
    const { status, body } = await authFetch("/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(status).toBe(401);
    expect(body.error.message).toBe("Invalid API key");
  });

  it("rejects requests with wrong key", async () => {
    const { status } = await authFetch("/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(status).toBe(401);
  });

  it("accepts requests with correct key", async () => {
    const { status, body } = await authFetch("/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(status).toBe(200);
    expect(body.object).toBe("chat.completion");
  });
});
