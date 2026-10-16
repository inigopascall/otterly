import { describe, it, expect } from "vitest";
import { ClaudeEngine, buildCLICommand, streamLines, CliTerminatedError } from "../src/engine.js";
import { AgentError } from "../src/errors.js";

const NODE = process.execPath;

async function drain(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

function queryOf(messages: Record<string, unknown>[]): any {
  return () => (async function* () { for (const m of messages) yield m; })();
}

describe("test isolation", () => {
  it("never resolves a real claude CLI in tests", () => {
    expect(process.env.OTTERLY_DISABLE_CLAUDE_CLI).toBe("1");
  });
});

describe("buildCLICommand partial messages", () => {
  it("asks the CLI for partial messages and summarised thinking", () => {
    const cmd = buildCLICommand("claude", {});
    expect(cmd).toContain("--include-partial-messages");
    expect(cmd).toContain("--thinking-display");
    expect(cmd[cmd.indexOf("--thinking-display") + 1]).toBe("summarized");
  });
});

describe("ClaudeEngine native tool_use in stream_event", () => {
  const messages = [
    { type: "system", subtype: "init", session_id: "s", model: "m", cwd: "/tmp", tools: [] },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } } },
    { type: "result", subtype: "success", result: "done", total_cost_usd: 0, duration_ms: 0, usage: { input_tokens: 0, output_tokens: 0 } },
  ];

  it("rejects with NATIVE_TOOL_CALL when clientToolCalls is set", async () => {
    const engine = new ClaudeEngine({}, queryOf(messages));
    const err = await drain(engine.stream("p", { clientToolCalls: true })).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("NATIVE_TOOL_CALL");
  });

  it("does not reject without clientToolCalls", async () => {
    const engine = new ClaudeEngine({}, queryOf(messages));
    const events = (await drain(engine.stream("p"))) as Array<{ type: string }>;
    expect(events.at(-1)?.type).toBe("result");
  });
});

describe("streamLines", () => {
  it("yields the first line before the child exits", async () => {
    const script = 'console.log("one"); setTimeout(() => console.log("two"), 2000);';
    const t0 = Date.now();
    const lines: string[] = [];
    const times: number[] = [];
    for await (const line of streamLines([NODE, "-e", script], { timeoutMs: 10000 })) {
      lines.push(line);
      times.push(Date.now() - t0);
    }
    expect(lines).toEqual(["one", "two"]);
    expect(times[0]).toBeLessThan(1000);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1500);
  }, 15000);

  it("joins a line split across two writes", async () => {
    const script = 'process.stdout.write("hel"); setTimeout(() => process.stdout.write("lo\\nworld\\n"), 300);';
    const lines = await drain(streamLines([NODE, "-e", script], { timeoutMs: 10000 }));
    expect(lines).toEqual(["hello", "world"]);
  }, 15000);

  it("throws CliTerminatedError idle after yielding the lines printed first", async () => {
    const script = 'console.log("first"); setInterval(() => {}, 1000);';
    const lines: string[] = [];
    let err: unknown = null;
    try {
      for await (const line of streamLines([NODE, "-e", script], { timeoutMs: 10000, idleTimeoutMs: 1500, killGraceMs: 500 })) {
        lines.push(line);
      }
    } catch (e) {
      err = e;
    }
    expect(lines).toEqual(["first"]);
    expect(err).toBeInstanceOf(CliTerminatedError);
    expect((err as CliTerminatedError).reason).toBe("idle");
  }, 15000);

  it("stops the child when the consumer breaks out early", async () => {
    const script = 'console.log(process.pid); setInterval(() => console.log("tick"), 100);';
    let pid = 0;
    for await (const line of streamLines([NODE, "-e", script], { timeoutMs: 10000, killGraceMs: 500 })) {
      pid = Number(line);
      break;
    }
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);
});
