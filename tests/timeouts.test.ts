import { describe, it, expect } from "vitest";
import http from "http";
import {
  ClaudeEngine,
  spawnWithAbort,
  CliTerminatedError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  CLI_BACKSTOP_MS,
  buildCLICommand,
} from "../src/engine.js";
import { AgentError } from "../src/errors.js";
import { errorToHttpStatus, openaiErrorBody } from "../src/server/openai-compat.js";
import { settleResponse } from "../src/server/settle.js";

const NODE = process.execPath;
// Prints one NDJSON line and some stderr, then never exits.
const PRINT_THEN_HANG = `process.stdout.write('{"type":"system"}\\n'); process.stderr.write('warming up'); setInterval(() => {}, 1000);`;

describe("spawnWithAbort termination", () => {
  it("keeps partial output when the hard timeout fires", async () => {
    const err = await spawnWithAbort([NODE, "-e", PRINT_THEN_HANG], { timeoutMs: 500, killGraceMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(CliTerminatedError);
    expect(err.reason).toBe("timeout");
    expect(err.stdout).toContain('{"type":"system"}');
    expect(err.stderr).toContain("warming up");
    expect(err.elapsedMs).toBeGreaterThanOrEqual(400);
  });

  it("keeps partial output when aborted", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const err = await spawnWithAbort([NODE, "-e", PRINT_THEN_HANG], { timeoutMs: 10_000, killGraceMs: 200, abortController: ac }).catch((e) => e);
    expect(err).toBeInstanceOf(CliTerminatedError);
    expect(err.reason).toBe("aborted");
    expect(err.stdout).toContain('{"type":"system"}');
  });

  it("passes chunks to the observer as they arrive", async () => {
    const seen: string[] = [];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await spawnWithAbort([NODE, "-e", PRINT_THEN_HANG], {
      timeoutMs: 10_000, killGraceMs: 200, abortController: ac,
      onStdout: (c) => seen.push(c.toString()),
    }).catch(() => {});
    expect(seen.join("")).toContain('{"type":"system"}');
  });

  it("stops a child whose signal was already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await spawnWithAbort([NODE, "-e", PRINT_THEN_HANG], { timeoutMs: 10_000, killGraceMs: 200, abortController: ac }).catch((e) => e);
    expect(err).toBeInstanceOf(CliTerminatedError);
    expect(err.reason).toBe("aborted");
  });
});

// A query that produces nothing until it is aborted, like a stalled CLI run.
function hangingQuery() {
  return async function* (args: { prompt: unknown; options: Record<string, unknown> }) {
    const ac = args.options.abortController as AbortController;
    await new Promise<void>((_, reject) => {
      if (ac.signal.aborted) reject(new Error("Aborted"));
      ac.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
    yield {} as Record<string, unknown>;
  };
}

describe("ClaudeEngine timeout classification", () => {
  it("rejects with TIMEOUT when the signal is aborted with a timeout reason", async () => {
    const controller = new AbortController();
    const run = new ClaudeEngine({}, hangingQuery()).run("hi", { signal: controller.signal });
    setTimeout(() => controller.abort(new AgentError("TIMEOUT", "No response from the model within 1 s.")), 20);
    await expect(run).rejects.toMatchObject({ code: "TIMEOUT", message: "No response from the model within 1 s." });
  });

  it("rejects with TIMEOUT when the signal had already timed out", async () => {
    const controller = new AbortController();
    controller.abort(new AgentError("TIMEOUT", "late"));
    await expect(new ClaudeEngine({}, hangingQuery()).run("hi", { signal: controller.signal })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("ends quietly when the client disconnects", async () => {
    const controller = new AbortController();
    const run = new ClaudeEngine({}, hangingQuery()).run("hi", { signal: controller.signal });
    setTimeout(() => controller.abort("client_disconnected"), 20);
    const result = await run;
    expect(result.text).toBe("");
  });

  it("maps the CLI's own hard timeout to TIMEOUT", async () => {
    const engine = new ClaudeEngine({}, async function* () {
      throw new CliTerminatedError("timeout", "CLI timed out after 360000ms", { stdout: "", stderr: "", elapsedMs: 360000 });
      yield {} as Record<string, unknown>;
    });
    await expect(engine.run("hi")).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("timeout status mapping", () => {
  it("maps TIMEOUT to 504", () => {
    expect(errorToHttpStatus(new AgentError("TIMEOUT", "x"))).toBe(504);
  });
  it("labels 504 as timeout_error", () => {
    expect(openaiErrorBody(504, "x").error.type).toBe("timeout_error");
  });
  it("defaults to a twenty-minute cap, a two-minute idle limit and a one-minute CLI backstop", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(1_200_000);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(CLI_BACKSTOP_MS).toBe(60_000);
  });
});

function serveOnce(handler: (res: http.ServerResponse) => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => handler(res));
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      http.get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() });
        });
      }).on("error", (e) => { server.close(); reject(e); });
    });
  });
}

describe("settleResponse", () => {
  it("answers an untouched timed-out request with a 504", async () => {
    let outcome = "";
    const { status, body } = await serveOnce((res) => { outcome = settleResponse(res, true, true); });
    expect(status).toBe(504);
    expect(JSON.parse(body).error.type).toBe("timeout_error");
    expect(outcome).toBe("timeout");
  });

  it("ends an open SSE stream with an error chunk and [DONE]", async () => {
    const { status, body } = await serveOnce((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": keepalive\n\n");
      settleResponse(res, true, true, true);
    });
    expect(status).toBe(200);
    expect(body).toContain('"type":"timeout_error"');
    expect(body.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("answers a handler that returned without writing with a 500", async () => {
    let outcome = "";
    const { status } = await serveOnce((res) => { outcome = settleResponse(res, false, true); });
    expect(status).toBe(500);
    expect(outcome).toBe("error");
  });

  it("leaves a finished response alone", async () => {
    let outcome = "";
    const { status, body } = await serveOnce((res) => {
      res.writeHead(200);
      res.end("ok");
      outcome = settleResponse(res, false, true);
    });
    expect(status).toBe(200);
    expect(body).toBe("ok");
    expect(outcome).toBe("ok");
  });
});

const PRINT_25_THEN_EXIT = `let n = 0; const t = setInterval(() => { process.stdout.write('{"type":"system"}\\n'); if (++n === 25) clearInterval(t); }, 100);`;
const PRINT_FOREVER = `setInterval(() => process.stdout.write('{"type":"system"}\\n'), 100);`;
const SILENT = `setInterval(() => {}, 1000);`;

describe("idle timeout", () => {
  it("lets a child that keeps printing run past the idle limit", async () => {
    const started = Date.now();
    const out = await spawnWithAbort([NODE, "-e", PRINT_25_THEN_EXIT], { timeoutMs: 10_000, idleTimeoutMs: 1000, killGraceMs: 200 });
    expect(Date.now() - started).toBeGreaterThan(1000);
    expect(out.split("\n").filter(Boolean)).toHaveLength(25);
  });

  it("stops a silent child at the idle limit", async () => {
    const err = await spawnWithAbort([NODE, "-e", SILENT], { timeoutMs: 10_000, idleTimeoutMs: 500, killGraceMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(CliTerminatedError);
    expect(err.reason).toBe("idle");
    expect(err.message).toContain("No output from the model");
    expect(err.elapsedMs).toBeGreaterThanOrEqual(450);
    expect(err.elapsedMs).toBeLessThan(5000);
  });

  it("still applies the hard cap to a child that never goes quiet", async () => {
    const err = await spawnWithAbort([NODE, "-e", PRINT_FOREVER], { timeoutMs: 1500, idleTimeoutMs: 1000, killGraceMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(CliTerminatedError);
    expect(err.reason).toBe("timeout");
  });

  it("maps an idle stop to TIMEOUT, which the routes answer with 504", async () => {
    const engine = new ClaudeEngine({}, async function* () {
      throw new CliTerminatedError("idle", "No output from the model for 120 s; the run was stopped.", { stdout: "", stderr: "", elapsedMs: 120000 });
      yield {} as Record<string, unknown>;
    });
    const err = await engine.run("hi").catch((e) => e);
    expect(err).toMatchObject({ code: "TIMEOUT" });
    expect(errorToHttpStatus(err)).toBe(504);
  });
});

describe("effort", () => {
  it("forwards the effort level to the CLI", () => {
    const argv = buildCLICommand("claude", { effort: "max" });
    expect(argv).toContain("--effort");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("max");
  });
  it("rejects an unknown effort level", () => {
    expect(() => buildCLICommand("claude", { effort: "extreme" })).toThrow("effort must be one of");
  });
  it("omits the flag when no effort is set", () => {
    expect(buildCLICommand("claude", {})).not.toContain("--effort");
  });
});
