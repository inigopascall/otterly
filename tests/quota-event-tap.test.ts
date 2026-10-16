import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeEngine, createCLIQueryFn } from "../src/engine.js";
import { quota } from "../src/server/quota.js";

// createCLIQueryFn passes every rate_limit_event the CLI prints to `quota`,
// from one-shot runs and Sessions alike, and still yields the line. Driven
// against tests/fixtures/fake-claude.mjs, which prints one for "RATE_LIMIT".
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
let dir = "";
let bin = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "otterly-quota-tap-"));
  bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(bin, 0o755);
  // An empty config dir: quota.snapshot() finds no credentials there, so it
  // reports the recorded events and makes no request.
  const configDir = join(dir, "config");
  mkdirSync(configDir);
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  quota.reset();
});

const engine = () => new ClaudeEngine({ cwd: dir }, createCLIQueryFn(bin));

async function expectRecorded(): Promise<void> {
  const body = await quota.snapshot();
  expect(body.five_hour).toMatchObject({ utilization: 4 });
  expect(body.seven_day).toMatchObject({ utilization: 43 });
  expect(body.otterly).toMatchObject({ source: "rate_limit_event", status: "allowed" });
}

describe("rate_limit_event tap in createCLIQueryFn", () => {
  it("records the event of a one-shot run in quota", async () => {
    expect((await engine().run("RATE_LIMIT")).text).toBe("echo: RATE_LIMIT");
    await expectRecorded();
  });

  it("records the event of a Session turn in quota", async () => {
    const session = engine().session();
    try {
      expect((await session.send("RATE_LIMIT")).text).toBe("echo: RATE_LIMIT");
    } finally {
      session.close();
    }
    await expectRecorded();
  });

  it("still yields the rate_limit_event line, unchanged", async () => {
    const lines: Array<Record<string, any>> = [];
    for await (const line of createCLIQueryFn(bin)({ prompt: "RATE_LIMIT", options: { cwd: dir } })) {
      lines.push(line);
    }
    expect(lines.map((line) => line.type)).toEqual(["system", "rate_limit_event", "assistant", "result"]);
    expect(lines[1].rate_limit_info).toMatchObject({
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.04 }, seven_day: { utilization: 0.43 } },
    });
  });
});
