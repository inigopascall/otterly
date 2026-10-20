import { describe, it, expect, vi } from "vitest";
import {
  QuotaTracker,
  usageArgv,
  authStatusArgv,
  parseUsageOutput,
  parseAuthStatus,
  LIVE_REUSE_MS,
  USAGE_MIN_INTERVAL_MS,
  LIVE_FAILURE_BACKOFF_MS,
  USAGE_TIMEOUT_MS,
  ACCOUNT_REUSE_MS,
  AUTH_TIMEOUT_MS,
  LIMIT_HOLD_MS,
  type QuotaDeps,
} from "../../src/server/quota.js";

// QuotaTracker with everything it takes from outside replaced: a clock the
// test moves, and a claude CLI runner that answers from a script. No test
// here spawns a process or touches the network.

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0); // 2026-10-16T12:00:00.000Z
const HOUR = 3_600_000;
const CLI = "/opt/claude/bin/claude";

// The rate_limit_info of a real rate_limit_event line (claude 2.1.296).
const EVENT_INFO = {
  status: "allowed",
  resetsAt: 1792161000,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  overageDisabledReason: "out_of_credits",
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.04, resetsAt: 1792161000 },
    seven_day: { utilization: 0.43, resetsAt: 1792638000 },
  },
};
// Its two resetsAt values, 1792161000 and 1792638000 epoch seconds.
const FIVE_HOUR_RESET = "2026-10-16T14:30:00.000Z";
const SEVEN_DAY_RESET = "2026-10-22T03:00:00.000Z";

// The usage_report that `claude -p /usage` printed (claude 2.1.296), verbatim.
const USAGE_REPORT = JSON.parse(
  `{"session":{"total_cost_usd":0,"total_api_duration_ms":0,"total_duration_ms":9219,"total_lines_added":0,"total_lines_removed":0,"model_usage":{}},"rate_limits":{"limits":[{"kind":"session","group":"session","percent":4,"resets_at":"2026-10-17T11:09:59.918669+00:00","scope":null,"severity":"normal","is_active":false},{"kind":"weekly_all","group":"weekly","percent":64,"resets_at":"2026-10-22T02:59:59.918692+00:00","scope":null,"severity":"normal","is_active":true},{"kind":"weekly_scoped","group":"weekly","percent":36,"resets_at":"2026-10-22T02:59:59.918836+00:00","scope":{"model":{"display_name":"Fable"},"surface":null},"severity":"normal","is_active":false}],"extra_usage":{"is_enabled":false,"monthly_limit":7500,"used_credits":0,"utilization":0,"currency":"GBP"}}}`,
);
const LIMITS = USAGE_REPORT.rate_limits.limits;
const EXTRA_USAGE = USAGE_REPORT.rate_limits.extra_usage;
// What that report maps to: percent as utilization, resets_at as ISO with Z.
const USAGE_FIVE_HOUR = { utilization: 4, resets_at: "2026-10-17T11:09:59.918Z" };
const USAGE_SEVEN_DAY = { utilization: 64, resets_at: "2026-10-22T02:59:59.918Z" };

/** The stdout of `claude -p /usage --output-format stream-json --verbose`. */
function usageStdout(report: unknown = USAGE_REPORT): string {
  return (
    [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "usage" }] },
        local_command_run: { command: "usage", args: "" },
        usage_report: report,
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
        total_cost_usd: 0,
        result: "usage",
        local_command: "usage",
      }),
    ].join("\n") + "\n"
  );
}

// The stdout of `claude auth status` (claude 2.1.302), with made-up values.
const AUTH_STDOUT = JSON.stringify(
  {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    analyticsDisabled: false,
    projectsDirectory: "/cfg/projects",
    configDirectory: "/cfg",
    email: "someone@example.com",
    orgId: "00000000-0000-0000-0000-000000000000",
    orgName: "Example Org",
    subscriptionType: "max",
  },
  null,
  2,
);
const ACCOUNT = { email: "someone@example.com", organization: "Example Org", subscription_type: "max", rate_limit_tier: null };

const NOT_LOGGED_IN_RESULT = JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" });

type Reply = () => string | Promise<string>;
const prints = (stdout: string): Reply => () => stdout;
const exits = (message: string): Reply => () => {
  throw new Error(message);
};

interface Call {
  argv: string[];
  opts: { cwd?: string; timeoutMs: number };
}

function harness(opts: { usage?: Reply[]; auth?: Reply[]; cli?: string | null; deps?: Partial<QuotaDeps> } = {}) {
  let now = T0;
  const usage = [...(opts.usage ?? [])];
  const auth = [...(opts.auth ?? [])];
  const calls: Call[] = [];
  const tracker = new QuotaTracker({
    run: async (argv, runOpts) => {
      calls.push({ argv, opts: runOpts });
      const reply = (argv[1] === "auth" ? auth : usage).shift();
      if (!reply) throw new Error("no reply scripted");
      return reply();
    },
    findCli: () => (opts.cli === undefined ? CLI : opts.cli),
    now: () => now,
    env: { CLAUDE_CONFIG_DIR: "/cfg" },
    homeDir: () => "/home/test",
    ...opts.deps,
  });
  return {
    tracker,
    calls,
    usageCalls: () => calls.filter((c) => c.argv[1] === "-p"),
    authCalls: () => calls.filter((c) => c.argv[1] === "auth"),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("QuotaTracker: rate_limit_event", () => {
  it("converts utilization to a percentage and resetsAt to ISO, and records status", async () => {
    const { tracker, calls } = harness({ cli: null });
    tracker.recordRateLimitEvent(EVENT_INFO);
    expect(await tracker.snapshot()).toEqual({
      five_hour: { utilization: 4, resets_at: FIVE_HOUR_RESET },
      seven_day: { utilization: 43, resets_at: SEVEN_DAY_RESET },
      otterly: {
        source: "rate_limit_event",
        observed_at: "2026-10-16T12:00:00.000Z",
        status: "allowed",
        limited_until: null,
        live_error: "claude CLI not found on PATH",
        config_dir: "/cfg",
        account: null,
      },
    });
    expect(calls).toHaveLength(0);
  });

  it("rounds a percentage to 2 decimals", async () => {
    const { tracker } = harness({ cli: null });
    tracker.recordRateLimitEvent({
      status: "allowed_warning",
      unifiedWindows: {
        five_hour: { utilization: 0.456789, resetsAt: 1792161000 },
        seven_day: { utilization: 1, resetsAt: 1792638000 },
      },
    });
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual({ utilization: 45.68, resets_at: FIVE_HOUR_RESET });
    expect(body.seven_day).toEqual({ utilization: 100, resets_at: SEVEN_DAY_RESET });
    expect(body.otterly.status).toBe("allowed_warning");
  });

  it("records the status of an event without unifiedWindows, and no window", async () => {
    const { tracker } = harness({ cli: null });
    tracker.recordRateLimitEvent({ status: "rejected", resetsAt: 1792161000, rateLimitType: "five_hour" });
    const body = await tracker.snapshot();
    expect(Object.keys(body)).toEqual(["otterly"]);
    expect(body.otterly).toMatchObject({ source: "none", observed_at: null, status: "rejected" });
  });
});

describe("QuotaTracker: claude /usage", () => {
  const REJECTED = { ...EVENT_INFO, status: "rejected" };

  it("maps the usage_report of claude /usage to five_hour, seven_day, limits and extra_usage", async () => {
    const { tracker } = harness({ usage: [prints(usageStdout())], auth: [prints(AUTH_STDOUT)] });
    expect(await tracker.snapshot()).toEqual({
      five_hour: USAGE_FIVE_HOUR,
      seven_day: USAGE_SEVEN_DAY,
      limits: LIMITS,
      extra_usage: EXTRA_USAGE,
      otterly: {
        source: "usage_command",
        observed_at: "2026-10-16T12:00:00.000Z",
        status: null,
        limited_until: null,
        live_error: null,
        config_dir: "/cfg",
        account: ACCOUNT,
      },
    });
  });

  it("runs exactly the /usage argv, with a 60 s timeout and the given working directory", async () => {
    const { tracker, usageCalls } = harness({ usage: [prints(usageStdout())], auth: [prints(AUTH_STDOUT)] });
    await tracker.snapshot({ cwd: "/srv/otterly" });
    expect(usageCalls()).toEqual([
      {
        argv: [
          CLI,
          "-p",
          "/usage",
          "--output-format",
          "stream-json",
          "--verbose",
          "--safe-mode",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
        ],
        opts: { cwd: "/srv/otterly", timeoutMs: 60_000 },
      },
    ]);
    expect(usageArgv(CLI)).toEqual(usageCalls()[0].argv);
    expect(USAGE_TIMEOUT_MS).toBe(60_000);
  });

  it("reports and holds when there is no claude CLI", async () => {
    const { tracker, calls } = harness({ cli: null });
    const body = await tracker.snapshot({ refresh: true });
    expect(calls).toHaveLength(0);
    expect(body).toEqual({
      otterly: {
        source: "none",
        observed_at: null,
        status: null,
        limited_until: null,
        live_error: "claude CLI not found on PATH",
        config_dir: "/cfg",
        account: null,
      },
    });
  });

  it("reuses a good /usage result for 5 minutes", async () => {
    const { tracker, usageCalls, advance } = harness({ usage: [prints(usageStdout()), prints(usageStdout())] });
    expect(LIVE_REUSE_MS).toBe(5 * 60 * 1000);
    await tracker.snapshot();
    advance(LIVE_REUSE_MS - 1);
    const body = await tracker.snapshot();
    expect(usageCalls()).toHaveLength(1);
    expect(body.five_hour).toEqual(USAGE_FIVE_HOUR);
    expect(body.otterly.observed_at).toBe("2026-10-16T12:00:00.000Z");
    advance(1);
    await tracker.snapshot();
    expect(usageCalls()).toHaveLength(2);
  });

  it("runs /usage on refresh, but never more than once per 60 s", async () => {
    const { tracker, usageCalls, advance } = harness({
      usage: [prints(usageStdout()), prints(usageStdout()), prints(usageStdout())],
    });
    expect(USAGE_MIN_INTERVAL_MS).toBe(60_000);
    await tracker.snapshot();
    advance(USAGE_MIN_INTERVAL_MS - 1);
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    advance(1);
    const body = await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(2);
    expect(body.otterly.observed_at).toBe("2026-10-16T12:01:00.000Z");
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(2);
    advance(USAGE_MIN_INTERVAL_MS);
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(3);
  });

  it.each([
    ["a non-zero exit", exits("claude exited 1: boom"), "claude /usage failed: claude exited 1: boom"],
    ["a timeout", exits("CLI timed out after 60000ms"), "claude /usage failed: CLI timed out after 60000ms"],
    [
      "output with no usage_report line",
      prints(NOT_LOGGED_IN_RESULT),
      "claude /usage printed no usage_report: Not logged in · Please run /login",
    ],
  ])("runs no /usage for 60 s after %s, refresh included", async (_label, reply, error) => {
    const { tracker, usageCalls, advance } = harness({ usage: [reply, prints(usageStdout())] });
    expect(LIVE_FAILURE_BACKOFF_MS).toBe(60_000);
    let body = await tracker.snapshot();
    expect(body.otterly.live_error).toBe(error);
    expect(body.otterly.source).toBe("none");
    expect(Object.keys(body)).toEqual(["otterly"]);
    advance(LIVE_FAILURE_BACKOFF_MS - 1);
    body = await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    expect(body.otterly.live_error).toBe(error);
    advance(1);
    body = await tracker.snapshot();
    expect(usageCalls()).toHaveLength(2);
    expect(body.otterly).toMatchObject({ source: "usage_command", live_error: null });
  });

  it("keeps the last good result through a failure", async () => {
    const { tracker, advance } = harness({ usage: [prints(usageStdout()), exits("claude exited 1: boom")] });
    await tracker.snapshot();
    advance(LIVE_REUSE_MS);
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual(USAGE_FIVE_HOUR);
    expect(body.otterly).toMatchObject({
      source: "usage_command",
      observed_at: "2026-10-16T12:00:00.000Z",
      live_error: "claude /usage failed: claude exited 1: boom",
    });
  });

  it("shares one /usage run between concurrent requests", async () => {
    let release!: (stdout: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { tracker, usageCalls } = harness({ usage: [() => gate, prints(usageStdout())] });
    const both = Promise.all([tracker.snapshot(), tracker.snapshot({ refresh: true })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(usageStdout());
    const [a, b] = await both;
    expect(usageCalls()).toHaveLength(1);
    expect(a.five_hour).toEqual(USAGE_FIVE_HOUR);
    expect(b.five_hour).toEqual(USAGE_FIVE_HOUR);
  });

  it("starts a fresh /usage for a rejected five_hour limit, clears on valid usage, and shares the interval", async () => {
    const { tracker, usageCalls, advance } = harness({
      usage: [prints(usageStdout()), prints(usageStdout())],
    });
    tracker.recordRateLimitEvent(REJECTED);
    const [a, b] = await Promise.all([tracker.snapshot({ refresh: true }), tracker.snapshot({ refresh: true })]);
    expect(usageCalls()).toHaveLength(1);
    expect(a.five_hour).toEqual(USAGE_FIVE_HOUR);
    expect(b.five_hour).toEqual(USAGE_FIVE_HOUR);
    expect(a.otterly).toMatchObject({ source: "usage_command", limited_until: null, live_error: null });
    expect(b.otterly).toMatchObject({ source: "usage_command", limited_until: null, live_error: null });
    expect(tracker.usageLimit()).toBeNull();
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    advance(USAGE_MIN_INTERVAL_MS);
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(2);
  });

  it("clears a rejected seven_day limit from fresh seven_day usage", async () => {
    const { tracker, usageCalls } = harness({
      usage: [prints(usageStdout({ rate_limits: { limits: [{ kind: "weekly_all", percent: 64, resets_at: "2026-10-22T02:59:59.918692+00:00" }] } }))],
    });
    tracker.recordRateLimitEvent({ ...REJECTED, rateLimitType: "seven_day", resetsAt: Date.parse(SEVEN_DAY_RESET) / 1000 });
    const body = await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    expect(body.seven_day).toEqual(USAGE_SEVEN_DAY);
    expect(body.otterly).toMatchObject({ source: "none", status: "rejected", limited_until: null });
    expect(tracker.usageLimit()).toBeNull();
  });

  it("keeps an unknown rejected limit after fresh valid windows", async () => {
    const { tracker, usageCalls } = harness({ usage: [prints(usageStdout())] });
    tracker.recordRateLimitEvent({
      status: "rejected",
      resetsAt: Date.parse(SEVEN_DAY_RESET) / 1000,
      rateLimitType: "unknown",
    });
    const body = await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    expect(tracker.usageLimit()?.type).toBe("unknown");
    expect(body.otterly.limited_until).toBe(SEVEN_DAY_RESET);
  });

  it("clears a rejected five_hour limit when fresh usage reports zero", async () => {
    const { tracker, usageCalls } = harness({
      usage: [prints(usageStdout({ rate_limits: { limits: [{ kind: "session", percent: 0, resets_at: FIVE_HOUR_RESET }] } }))],
    });
    tracker.recordRateLimitEvent(REJECTED);
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    expect(tracker.usageLimit()).toBeNull();
  });

  it("keeps five_hour blocked when fresh usage has seven_day but no five_hour percent", async () => {
    const { tracker } = harness({
      usage: [prints(usageStdout({ rate_limits: { limits: [{ kind: "weekly_all", percent: 64, resets_at: "2026-10-22T02:59:59.918692+00:00" }] } }))],
    });
    tracker.recordRateLimitEvent(REJECTED);
    const body = await tracker.snapshot({ refresh: true });
    expect(body.seven_day).toEqual(USAGE_SEVEN_DAY);
    expect(body.otterly.limited_until).toBe(FIVE_HOUR_RESET);
    expect(tracker.usageLimit()).toEqual({ until: Date.parse(FIVE_HOUR_RESET), type: "five_hour", retryAfterS: 9000 });
  });

  it.each([
    ["five_hour", "missing", {}],
    ["five_hour", "unknown binding type", { kind: "unknown", percent: 64, resets_at: FIVE_HOUR_RESET }],
    ["five_hour", "NaN", { kind: "session", percent: Number.NaN, resets_at: FIVE_HOUR_RESET }],
    ["five_hour", "negative", { kind: "session", percent: -1, resets_at: FIVE_HOUR_RESET }],
    ["five_hour", "100", { kind: "session", percent: 100, resets_at: FIVE_HOUR_RESET }],
    ["five_hour", "Infinity", { kind: "session", percent: Number.POSITIVE_INFINITY, resets_at: FIVE_HOUR_RESET }],
    ["seven_day", "missing", {}],
    ["seven_day", "unknown binding type", { kind: "unknown", percent: 64, resets_at: SEVEN_DAY_RESET }],
    ["seven_day", "NaN", { kind: "weekly_all", percent: Number.NaN, resets_at: SEVEN_DAY_RESET }],
    ["seven_day", "negative", { kind: "weekly_all", percent: -1, resets_at: SEVEN_DAY_RESET }],
    ["seven_day", "100", { kind: "weekly_all", percent: 100, resets_at: SEVEN_DAY_RESET }],
    ["seven_day", "Infinity", { kind: "weekly_all", percent: Number.POSITIVE_INFINITY, resets_at: SEVEN_DAY_RESET }],
  ])("retains a rejected %s window when its %s usage percent is invalid", async (type, label, limit) => {
    const report = { rate_limits: { limits: [limit] } };
    const stdout = usageStdout(report);
    if (label === "NaN" || label === "Infinity") expect(JSON.parse(JSON.stringify(limit)).percent).toBeNull();
    const { tracker, usageCalls } = harness({ usage: [prints(stdout)] });
    tracker.recordRateLimitEvent({
      ...REJECTED,
      rateLimitType: type,
      resetsAt: type === "five_hour" ? Date.parse(FIVE_HOUR_RESET) / 1000 : Date.parse(SEVEN_DAY_RESET) / 1000,
    });
    const body = await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    expect(body.otterly.limited_until).toBe(type === "five_hour" ? FIVE_HOUR_RESET : SEVEN_DAY_RESET);
    expect(tracker.usageLimit()).not.toBeNull();
  });

  it.each([
    ["a failed CLI", exits("claude exited 1: boom")],
    ["no usage report", prints(NOT_LOGGED_IN_RESULT)],
  ])("retains the old rejected limit after %s and applies the 60 s backoff", async (_label, reply) => {
    const { tracker, usageCalls, advance } = harness({ usage: [reply, prints(usageStdout())] });
    tracker.recordRateLimitEvent(REJECTED);
    const body = await tracker.snapshot({ refresh: true });
    expect(body.five_hour).toEqual({ utilization: 4, resets_at: FIVE_HOUR_RESET });
    expect(body.otterly.limited_until).toBe(FIVE_HOUR_RESET);
    advance(USAGE_MIN_INTERVAL_MS - 1);
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    advance(1);
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(2);
  });

  it("does not use a prior successful snapshot as evidence after a later rejection", async () => {
    const { tracker, usageCalls, advance } = harness({ usage: [prints(usageStdout()), prints(usageStdout())] });
    await tracker.snapshot();
    advance(USAGE_MIN_INTERVAL_MS);
    tracker.recordRateLimitEvent(REJECTED);
    const body = await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(2);
    expect(body.otterly.source).toBe("usage_command");
    expect(body.otterly.limited_until).toBeNull();
  });

  it("shares one injected /usage among concurrent blocked snapshots and probes again after 60 s", async () => {
    let release!: (stdout: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { tracker, usageCalls, advance } = harness({ usage: [() => gate, prints(usageStdout())] });
    tracker.recordRateLimitEvent(REJECTED);
    const both = Promise.all([tracker.snapshot({ refresh: true }), tracker.snapshot({ refresh: true })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usageCalls()).toHaveLength(1);
    release(usageStdout());
    await both;
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(1);
    advance(USAGE_MIN_INTERVAL_MS);
    await tracker.snapshot({ refresh: true });
    expect(usageCalls()).toHaveLength(2);
  });

  it("does not let an in-flight /usage clear a newer rejected event", async () => {
    let release!: (stdout: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { tracker, usageCalls, advance } = harness({ usage: [() => gate] });
    tracker.recordRateLimitEvent(REJECTED);
    const probe = tracker.snapshot({ refresh: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usageCalls()).toHaveLength(1);
    advance(1);
    tracker.recordRateLimitEvent({ ...REJECTED, resetsAt: Date.parse(SEVEN_DAY_RESET) / 1000, rateLimitType: "seven_day" });
    release(usageStdout());
    const body = await probe;
    expect(body.otterly.limited_until).toBe(SEVEN_DAY_RESET);
    expect(tracker.usageLimit()).toEqual({ until: Date.parse(SEVEN_DAY_RESET), type: "seven_day", retryAfterS: 486000 });
  });

  it("does not let an in-flight /usage clear a newer rejected event when it started unblocked", async () => {
    let release!: (stdout: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { tracker, usageCalls, advance } = harness({ usage: [() => gate] });
    const probe = tracker.snapshot({ refresh: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usageCalls()).toHaveLength(1);
    advance(1);
    tracker.recordRateLimitEvent(REJECTED);
    release(usageStdout());
    const body = await probe;
    expect(body.otterly.limited_until).toBe(FIVE_HOUR_RESET);
    expect(tracker.usageLimit()).not.toBeNull();
  });

  it("makes no network request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const { tracker } = harness({ usage: [prints(usageStdout())], auth: [prints(AUTH_STDOUT)] });
      await tracker.snapshot({ refresh: true });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("reports ~/.claude as the config dir when CLAUDE_CONFIG_DIR is unset", async () => {
    const { tracker } = harness({ cli: null, deps: { env: {} } });
    expect((await tracker.snapshot()).otterly.config_dir).toBe("/home/test/.claude");
  });
});

describe("parseUsageOutput", () => {
  it("passes limits and extra_usage through verbatim, resets_at included", () => {
    const parsed = parseUsageOutput(usageStdout());
    expect(parsed).toEqual({
      body: { five_hour: USAGE_FIVE_HOUR, seven_day: USAGE_SEVEN_DAY, limits: LIMITS, extra_usage: EXTRA_USAGE },
    });
    expect((parsed as { body: { limits: Array<{ resets_at: string }> } }).body.limits[0].resets_at).toBe(
      "2026-10-17T11:09:59.918669+00:00",
    );
  });

  it("skips lines that are not JSON", () => {
    expect(parseUsageOutput(`Warning: something\n${usageStdout()}`)).toMatchObject({ body: { five_hour: USAGE_FIVE_HOUR } });
  });

  it("leaves out a window whose entry has no percent", () => {
    const report = {
      rate_limits: {
        limits: [
          { kind: "session", resets_at: "2026-10-17T11:09:59.918669+00:00" },
          { kind: "weekly_all", percent: 64, resets_at: "2026-10-22T02:59:59.918692+00:00" },
        ],
      },
    };
    const parsed = parseUsageOutput(usageStdout(report)) as { body: Record<string, unknown> };
    expect(Object.keys(parsed.body).sort()).toEqual(["limits", "seven_day"]);
  });

  it("gives the result text when no line carries a usage_report", () => {
    expect(parseUsageOutput(NOT_LOGGED_IN_RESULT)).toEqual({
      problem: "claude /usage printed no usage_report: Not logged in · Please run /login",
    });
    expect(parseUsageOutput("")).toEqual({ problem: "claude /usage printed no usage_report" });
  });
});

describe("QuotaTracker: claude auth status", () => {
  it("runs claude auth status with a 30 s timeout and the given working directory", async () => {
    const { tracker, authCalls } = harness({ auth: [prints(AUTH_STDOUT)] });
    const body = await tracker.snapshot({ cwd: "/srv/otterly" });
    expect(authCalls()).toEqual([{ argv: [CLI, "auth", "status"], opts: { cwd: "/srv/otterly", timeoutMs: 30_000 } }]);
    expect(authStatusArgv(CLI)).toEqual([CLI, "auth", "status"]);
    expect(AUTH_TIMEOUT_MS).toBe(30_000);
    expect(body.otterly.account).toEqual(ACCOUNT);
  });

  it("parses email, orgName, subscriptionType and rateLimitTier, null for each one absent", () => {
    expect(parseAuthStatus(AUTH_STDOUT)).toEqual(ACCOUNT);
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, rateLimitTier: "default_claude_max_20x" }))).toEqual({
      email: null,
      organization: null,
      subscription_type: null,
      rate_limit_tier: "default_claude_max_20x",
    });
  });

  it("gives null for output that is not a JSON object, or says loggedIn: false", () => {
    expect(parseAuthStatus("Not logged in")).toBeNull();
    expect(parseAuthStatus("[]")).toBeNull();
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false, authMethod: "none" }))).toBeNull();
  });

  it("reports account null when claude auth status fails", async () => {
    const { tracker, advance } = harness({
      auth: [prints(AUTH_STDOUT), exits('claude exited 1: {"loggedIn": false}')],
    });
    expect((await tracker.snapshot()).otterly.account).toEqual(ACCOUNT);
    advance(USAGE_MIN_INTERVAL_MS);
    expect((await tracker.snapshot({ refresh: true })).otterly.account).toBeNull();
  });

  it("runs claude auth status at most once per 30 minutes, and on refresh at most once per 60 s", async () => {
    const { tracker, authCalls, advance } = harness({
      auth: [prints(AUTH_STDOUT), prints(AUTH_STDOUT), prints(AUTH_STDOUT)],
    });
    expect(ACCOUNT_REUSE_MS).toBe(30 * 60 * 1000);
    await tracker.snapshot();
    advance(ACCOUNT_REUSE_MS - 1);
    await tracker.snapshot();
    expect(authCalls()).toHaveLength(1);
    advance(1);
    await tracker.snapshot();
    expect(authCalls()).toHaveLength(2);
    await tracker.snapshot({ refresh: true });
    expect(authCalls()).toHaveLength(2);
    advance(USAGE_MIN_INTERVAL_MS);
    await tracker.snapshot({ refresh: true });
    expect(authCalls()).toHaveLength(3);
  });
});

describe("QuotaTracker: merge", () => {
  it("lets a rate_limit_event observed after the /usage result replace five_hour and seven_day", async () => {
    const { tracker, usageCalls, advance } = harness({ usage: [prints(usageStdout())] });
    await tracker.snapshot();
    advance(60_000);
    tracker.recordRateLimitEvent(EVENT_INFO);
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual({ utilization: 4, resets_at: FIVE_HOUR_RESET });
    expect(body.seven_day).toEqual({ utilization: 43, resets_at: SEVEN_DAY_RESET });
    expect(body.limits).toEqual(LIMITS);
    expect(body.extra_usage).toEqual(EXTRA_USAGE);
    expect(body.otterly).toMatchObject({
      source: "rate_limit_event",
      observed_at: "2026-10-16T12:01:00.000Z",
      status: "allowed",
    });
    expect(usageCalls()).toHaveLength(1);
  });

  it("keeps the /usage figures over a rate_limit_event observed before them", async () => {
    const { tracker, advance } = harness({ usage: [prints(usageStdout())] });
    tracker.recordRateLimitEvent(EVENT_INFO);
    advance(1_000);
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual(USAGE_FIVE_HOUR);
    expect(body.seven_day).toEqual(USAGE_SEVEN_DAY);
    expect(body.otterly).toMatchObject({
      source: "usage_command",
      observed_at: "2026-10-16T12:00:01.000Z",
      status: "allowed",
    });
  });
});

describe("QuotaTracker: expired windows", () => {
  it("reports a /usage window whose reset time has passed as 0 and null", async () => {
    const { tracker, advance } = harness({ usage: [prints(usageStdout()), exits("claude exited 1: boom")] });
    await tracker.snapshot();
    advance(23 * HOUR + 10 * 60_000); // 11:10 on the 17th, past the five_hour reset
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual({ utilization: 0, resets_at: null });
    expect(body.seven_day).toEqual(USAGE_SEVEN_DAY);
    expect(body.otterly.live_error).toBe("claude /usage failed: claude exited 1: boom");
  });

  it("reports an event window whose reset time has passed as 0 and null", async () => {
    const { tracker, advance } = harness({ cli: null });
    tracker.recordRateLimitEvent(EVENT_INFO);
    advance(2.5 * HOUR + 1); // just past 14:30, the five_hour reset
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual({ utilization: 0, resets_at: null });
    expect(body.seven_day).toEqual({ utilization: 43, resets_at: SEVEN_DAY_RESET });
  });
});

describe("QuotaTracker: usage limit", () => {
  // EVENT_INFO, rejected: the five_hour window binds until FIVE_HOUR_RESET,
  // 2.5 hours after T0.
  const REJECTED = { ...EVENT_INFO, status: "rejected" };
  const UNTIL = Date.parse(FIVE_HOUR_RESET);

  it("starts unlimited", async () => {
    const { tracker } = harness({ cli: null });
    expect(tracker.usageLimit()).toBeNull();
    expect((await tracker.snapshot()).otterly.limited_until).toBeNull();
  });

  it("is limited until resetsAt after a rejected event", async () => {
    const { tracker } = harness({ cli: null });
    tracker.recordRateLimitEvent(REJECTED);
    expect(tracker.usageLimit()).toEqual({ until: UNTIL, type: "five_hour", retryAfterS: 9000 });
    expect((await tracker.snapshot()).otterly).toMatchObject({ status: "rejected", limited_until: FIVE_HOUR_RESET });
  });

  it("lifts at resetsAt, rounding Retry-After up to whole seconds until then", async () => {
    const { tracker, advance } = harness({ cli: null });
    tracker.recordRateLimitEvent(REJECTED);
    advance(UNTIL - T0 - 1_500);
    expect(tracker.usageLimit()?.retryAfterS).toBe(2);
    advance(1_499); // 1 ms before the reset
    expect(tracker.usageLimit()).toEqual({ until: UNTIL, type: "five_hour", retryAfterS: 1 });
    advance(1);
    expect(tracker.usageLimit()).toBeNull();
    expect((await tracker.snapshot()).otterly.limited_until).toBeNull();
  });

  it("holds LIMIT_HOLD_MS (5 minutes) when the event has no resetsAt, and names the window unknown", async () => {
    const { tracker, advance } = harness({ cli: null });
    tracker.recordRateLimitEvent({ status: "rejected" });
    expect(LIMIT_HOLD_MS).toBe(5 * 60 * 1000);
    expect(tracker.usageLimit()).toEqual({ until: T0 + LIMIT_HOLD_MS, type: "unknown", retryAfterS: 300 });
    expect((await tracker.snapshot()).otterly.limited_until).toBe("2026-10-16T12:05:00.000Z");
    advance(LIMIT_HOLD_MS - 1);
    expect(tracker.usageLimit()).not.toBeNull();
    advance(1);
    expect(tracker.usageLimit()).toBeNull();
  });

  it.each(["allowed", "allowed_warning"])("ends at once with a later %s event", async (status) => {
    const { tracker, advance } = harness({ cli: null });
    tracker.recordRateLimitEvent(REJECTED);
    advance(60_000);
    tracker.recordRateLimitEvent({ ...EVENT_INFO, status });
    expect(tracker.usageLimit()).toBeNull();
    expect((await tracker.snapshot()).otterly.limited_until).toBeNull();
  });

  it("is forgotten by reset", () => {
    const { tracker } = harness({ cli: null });
    tracker.recordRateLimitEvent(REJECTED);
    tracker.reset();
    expect(tracker.usageLimit()).toBeNull();
  });
});
