import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, type ApiServerHandle } from "../../src/server/index.js";
import { quota } from "../../src/server/quota.js";

// GET /api/quota, served from the real `quota` singleton. CLAUDE_CONFIG_DIR
// points at an empty directory for the whole file, and the test configuration
// hides the claude CLI (OTTERLY_DISABLE_CLAUDE_CLI), so the tracker runs no
// command and reports that it found no CLI.

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
let configDir = "";

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "otterly-quota-route-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  quota.reset();
});

function get(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method: "GET", headers }, (res) => {
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
    req.end();
  });
}

async function start(): Promise<{ handle: ApiServerHandle; base: string }> {
  const handle = await startApiServer({ port: 0, workingDir: "/test", verifyCli: false });
  const { port } = handle.server.address() as { port: number };
  return { handle, base: `http://localhost:${port}` };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("GET /api/quota", () => {
  let handle: ApiServerHandle;
  let base = "";

  beforeAll(async () => {
    ({ handle, base } = await start());
  });

  afterAll(() => {
    handle.close();
  });

  it("answers 200 with only the otterly key, in its full shape, and source none when there is no data", async () => {
    const { status, body } = await get(base, "/api/quota");
    expect(status).toBe(200);
    expect(body).toEqual({
      otterly: {
        source: "none",
        observed_at: null,
        status: null,
        limited_until: null,
        live_error: "claude CLI not found on PATH",
        config_dir: configDir,
        account: null,
      },
    });
  });

  it("answers 200 with Anthropic-shaped windows after a rate_limit_event", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    quota.recordRateLimitEvent({
      status: "allowed_warning",
      unifiedWindows: {
        five_hour: { utilization: 0.04, resetsAt },
        seven_day: { utilization: 0.43, resetsAt: resetsAt + 6 * 86_400 },
      },
    });
    const { status, body } = await get(base, "/api/quota");
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["five_hour", "otterly", "seven_day"]);
    expect(body.five_hour).toEqual({ utilization: 4, resets_at: new Date(resetsAt * 1000).toISOString() });
    expect(body.seven_day).toEqual({
      utilization: 43,
      resets_at: new Date((resetsAt + 6 * 86_400) * 1000).toISOString(),
    });
    expect(body.otterly).toMatchObject({
      source: "rate_limit_event",
      status: "allowed_warning",
      config_dir: configDir,
      account: null,
    });
    expect(body.otterly.observed_at).toMatch(ISO);
  });

  it("passes ?refresh=1 and the server's working directory on to the tracker", async () => {
    const spy = vi.spyOn(quota, "snapshot");
    try {
      await get(base, "/api/quota?refresh=1");
      await get(base, "/api/quota");
      expect(spy.mock.calls).toEqual([[{ refresh: true, cwd: "/test" }], [{ refresh: false, cwd: "/test" }]]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /api/quota with OTTERLY_API_KEY set", () => {
  let handle: ApiServerHandle;
  let base = "";

  beforeAll(async () => {
    process.env.OTTERLY_API_KEY = "quota-secret";
    ({ handle, base } = await start());
  });

  afterAll(() => {
    delete process.env.OTTERLY_API_KEY;
    handle.close();
  });

  it("answers 401 without the bearer token", async () => {
    const { status, body } = await get(base, "/api/quota");
    expect(status).toBe(401);
    expect(body).toEqual({ error: "Invalid API key" });
  });

  it("answers 200 with the bearer token", async () => {
    const { status, body } = await get(base, "/api/quota", { Authorization: "Bearer quota-secret" });
    expect(status).toBe(200);
    expect(body.otterly.source).toBe("none");
  });

  it("leaves the other GET routes open", async () => {
    const { status } = await get(base, "/api/status");
    expect(status).toBe(200);
  });
});
