import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";

vi.mock("@anthropic-ai/claude-code", () => ({
  query: vi.fn(() => (async function* () {
    yield { type: "system", subtype: "init", session_id: "ws-s1", model: "m", cwd: "/tmp", tools: [] };
    yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } };
    yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } };
    yield { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } };
    yield { type: "result", subtype: "success", result: "Hello", total_cost_usd: 0, duration_ms: 1, session_id: "ws-s1", usage: { input_tokens: 1, output_tokens: 1 } };
  })()),
}));

import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";

let handle: ApiServerHandle;
let port: number;

beforeAll(async () => {
  handle = await startApiServer({ port: 0, workingDir: "/tmp" });
  port = (handle.server.address() as { port: number }).port;
});
afterAll(() => handle.close());

describe("/ws streaming", () => {
  it("sends text deltas and not the consolidated text block", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const msgs: any[] = [];
    const finished = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        msgs.push(m);
        if (m.kind === "status" && m.status === "ready" && msgs.some((x) => x.kind === "result")) resolve();
      });
    });
    ws.send(JSON.stringify({ type: "chat", text: "hi" }));
    await finished;
    ws.close();
    expect(msgs.filter((m) => m.kind === "text_delta").map((m) => m.delta)).toEqual(["Hel", "lo"]);
    expect(msgs.some((m) => m.kind === "text")).toBe(false);
    expect(msgs.find((m) => m.kind === "result")?.text).toBe("Hello");
  });
});
