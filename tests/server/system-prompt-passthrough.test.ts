// Regression: the OpenAI-compat endpoint must pass the caller's system prompt
// through to Claude Code verbatim. A past release shipped a "chat-only guard"
// that prepended `Do NOT use any tools (no Read, Write, Bash, Edit, etc.)` to
// every request, which silently broke agentic tool use for any client that
// expected Claude Code's built-in Read/Bash/Edit/Write to fire.
//
// These tests pin the contract: whatever the caller sends as system content is
// what Claude Code sees. No hidden anti-tool guardrails. If a regression
// reintroduces one, these tests fail.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "http";

// Capture what the engine was called with. Vitest hoists vi.mock(), so we
// stash the spy on globalThis and reach it from the test body.
const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
(globalThis as unknown as { __queryCalls: typeof queryCalls }).__queryCalls = queryCalls;

vi.mock("@anthropic-ai/claude-code", () => ({
  query: vi.fn(({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const calls = (globalThis as unknown as { __queryCalls: typeof queryCalls }).__queryCalls;
    calls.push({ prompt, options });
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
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        total_cost_usd: 0,
        duration_ms: 1,
        session_id: "test-session",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })();
  }),
}));

import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";

let handle: ApiServerHandle;
let baseUrl: string;

function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* keep raw */
          }
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const lastCall = () => queryCalls[queryCalls.length - 1];

describe("OpenAI-compat system prompt passthrough", () => {
  beforeAll(async () => {
    handle = await startApiServer({ port: 0, workingDir: "/test" });
    const addr = handle.server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    handle.close();
    queryCalls.length = 0;
  });

  // Phrases that MUST NOT appear in the system prompt sent to Claude Code.
  // These are the exact wordings from past regressions where a chat-only
  // guard was injected. If any of them sneak back in, agentic tool use
  // breaks silently — the model just says "I'll check" and stops.
  const FORBIDDEN_PHRASES = [
    "Do NOT use any tools",
    "no Read, Write, Bash, Edit",
    "respond ONLY with text",
    "reply with text only",
    "chat completion model",
  ];

  it("passes a caller's system message through verbatim", async () => {
    queryCalls.length = 0;
    const userSystem = "You are an agent that uses tools. Read files when asked.";
    const { status } = await post("/v1/chat/completions", {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: userSystem },
        { role: "user", content: "hi" },
      ],
      stream: false,
    });
    expect(status).toBe(200);
    expect(queryCalls.length).toBe(1);
    const sp = String(lastCall().options.systemPrompt ?? "");
    expect(sp).toBe(userSystem);
  });

  it("does not inject any chat-only / no-tools guard wording", async () => {
    queryCalls.length = 0;
    const { status } = await post("/v1/chat/completions", {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "You can call tools." },
        { role: "user", content: "do the thing" },
      ],
      stream: false,
    });
    expect(status).toBe(200);
    const sp = String(lastCall().options.systemPrompt ?? "");
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(sp).not.toContain(phrase);
    }
  });

  it("sends no systemPrompt option when caller provides none (no hidden default)", async () => {
    queryCalls.length = 0;
    const { status } = await post("/v1/chat/completions", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(status).toBe(200);
    expect(lastCall().options.systemPrompt).toBeUndefined();
  });

  it("appends JSON-mode instruction but does not add tool-suppression guard", async () => {
    queryCalls.length = 0;
    const { status } = await post("/v1/chat/completions", {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "give me data" },
      ],
      response_format: { type: "json_object" },
      stream: false,
    });
    expect(status).toBe(200);
    const sp = String(lastCall().options.systemPrompt ?? "");
    // JSON instruction is allowed (it's a real OpenAI feature).
    expect(sp).toContain("be terse");
    expect(sp).toContain("valid JSON");
    // But the chat-only / no-tools guard still must not appear.
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(sp).not.toContain(phrase);
    }
  });
});
