import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QuotaTracker,
  USAGE_URL,
  LIVE_REUSE_MS,
  LIVE_429_BACKOFF_MS,
  LIVE_FAILURE_BACKOFF_MS,
  LIMIT_HOLD_MS,
  type QuotaDeps,
} from "../../src/server/quota.js";
import { TESTED_CLAUDE_CLI_VERSION } from "../../src/engine.js";

// QuotaTracker with everything it takes from outside replaced: a clock the
// test moves, files held in memory, and a usage endpoint that answers from a
// script. Nothing here touches the network or a real Claude config dir.

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0); // 2026-10-16T12:00:00.000Z
const HOUR = 3_600_000;
const CREDENTIALS = "/cfg/.credentials.json";
const CLAUDE_JSON = "/cfg/.claude.json";

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

// An abridged usage-endpoint body; there utilization is already a percentage.
const LIVE_BODY = {
  five_hour: { utilization: 10, resets_at: "2026-10-16T15:00:00.000Z" },
  seven_day: { utilization: 50, resets_at: "2026-10-21T09:00:00.000Z" },
  seven_day_opus: { utilization: 5, resets_at: "2026-10-21T09:00:00.000Z" },
  extra_usage: { is_enabled: false, monthly_limit: null },
  limits: [{ window: "five_hour" }],
};

type Reply = () => Response;
const ok = (body: unknown): Reply => () => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number, headers: Record<string, string> = {}): Reply => () =>
  new Response("{}", { status, headers });
const networkError: Reply = () => {
  throw new TypeError("fetch failed");
};

/** A credentials file whose token expires at `expiresAt` (epoch s or ms). */
function credentials(expiresAt: number, accessToken: string | null = "test-token"): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "test-refresh",
      expiresAt,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  });
}
const CLAUDE_JSON_BODY = JSON.stringify({
  oauthAccount: { emailAddress: "someone@example.com", organizationName: "Example Org" },
});
const VALID_FILES = { [CREDENTIALS]: credentials(T0 + 24 * HOUR), [CLAUDE_JSON]: CLAUDE_JSON_BODY };

function harness(opts: { files?: Record<string, string>; replies?: Reply[]; deps?: Partial<QuotaDeps> } = {}) {
  let now = T0;
  const files = opts.files ?? {};
  const replies = [...(opts.replies ?? [])];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const tracker = new QuotaTracker({
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      const reply = replies.shift();
      if (!reply) throw new Error("no reply scripted");
      return reply();
    },
    now: () => now,
    env: { CLAUDE_CONFIG_DIR: "/cfg" },
    homeDir: () => "/home/test",
    ...opts.deps,
  });
  return {
    tracker,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("QuotaTracker: rate_limit_event", () => {
  it("converts utilization to a percentage and resetsAt to ISO, and records status", async () => {
    const { tracker, requests } = harness();
    tracker.recordRateLimitEvent(EVENT_INFO);
    expect(await tracker.snapshot()).toEqual({
      five_hour: { utilization: 4, resets_at: FIVE_HOUR_RESET },
      seven_day: { utilization: 43, resets_at: SEVEN_DAY_RESET },
      otterly: {
        source: "rate_limit_event",
        observed_at: "2026-10-16T12:00:00.000Z",
        status: "allowed",
        limited_until: null,
        live_error: "cannot read /cfg/.credentials.json",
        config_dir: "/cfg",
        account: null,
      },
    });
    expect(requests).toHaveLength(0);
  });

  it("rounds a percentage to 2 decimals", async () => {
    const { tracker } = harness();
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
    const { tracker } = harness();
    tracker.recordRateLimitEvent({ status: "rejected", resetsAt: 1792161000, rateLimitType: "five_hour" });
    const body = await tracker.snapshot();
    expect(Object.keys(body)).toEqual(["otterly"]);
    expect(body.otterly).toMatchObject({ source: "none", observed_at: null, status: "rejected" });
  });
});

describe("QuotaTracker: merge", () => {
  it("passes the live body through whole", async () => {
    const { tracker, requests } = harness({ files: VALID_FILES, replies: [ok(LIVE_BODY)] });
    expect(await tracker.snapshot()).toEqual({
      ...LIVE_BODY,
      otterly: {
        source: "oauth_usage",
        observed_at: "2026-10-16T12:00:00.000Z",
        status: null,
        limited_until: null,
        live_error: null,
        config_dir: "/cfg",
        account: {
          email: "someone@example.com",
          organization: "Example Org",
          subscription_type: "max",
          rate_limit_tier: "default_claude_max_20x",
        },
      },
    });
    expect(requests).toHaveLength(1);
  });

  it("lets a rate_limit_event observed after the live body replace five_hour and seven_day", async () => {
    const { tracker, requests, advance } = harness({ files: VALID_FILES, replies: [ok(LIVE_BODY)] });
    await tracker.snapshot();
    advance(60_000);
    tracker.recordRateLimitEvent(EVENT_INFO);
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual({ utilization: 4, resets_at: FIVE_HOUR_RESET });
    expect(body.seven_day).toEqual({ utilization: 43, resets_at: SEVEN_DAY_RESET });
    expect(body.seven_day_opus).toEqual(LIVE_BODY.seven_day_opus);
    expect(body.extra_usage).toEqual(LIVE_BODY.extra_usage);
    expect(body.limits).toEqual(LIVE_BODY.limits);
    expect(body.otterly).toMatchObject({
      source: "rate_limit_event",
      observed_at: "2026-10-16T12:01:00.000Z",
      status: "allowed",
    });
    expect(requests).toHaveLength(1);
  });

  it("keeps the live figures over a rate_limit_event observed before them", async () => {
    const { tracker, advance } = harness({ files: VALID_FILES, replies: [ok(LIVE_BODY)] });
    tracker.recordRateLimitEvent(EVENT_INFO);
    advance(1_000);
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual(LIVE_BODY.five_hour);
    expect(body.seven_day).toEqual(LIVE_BODY.seven_day);
    expect(body.otterly).toMatchObject({
      source: "oauth_usage",
      observed_at: "2026-10-16T12:00:01.000Z",
      status: "allowed",
    });
  });
});

describe("QuotaTracker: expired windows", () => {
  it("reports a live window whose reset time has passed as 0 and null", async () => {
    const { tracker, advance } = harness({ files: VALID_FILES, replies: [ok(LIVE_BODY), fail(500)] });
    await tracker.snapshot();
    advance(3 * HOUR); // 15:00, the five_hour reset
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual({ utilization: 0, resets_at: null });
    expect(body.seven_day).toEqual(LIVE_BODY.seven_day);
    expect(body.otterly.live_error).toBe("usage endpoint answered HTTP 500");
  });

  it("reports an event window whose reset time has passed as 0 and null", async () => {
    const { tracker, advance } = harness();
    tracker.recordRateLimitEvent(EVENT_INFO);
    advance(2.5 * HOUR + 1); // just past 14:30, the five_hour reset
    const body = await tracker.snapshot();
    expect(body.five_hour).toEqual({ utilization: 0, resets_at: null });
    expect(body.seven_day).toEqual({ utilization: 43, resets_at: SEVEN_DAY_RESET });
  });
});

describe("QuotaTracker: live read", () => {
  it("sends the CLI's token with the usage endpoint's headers", async () => {
    const { tracker, requests } = harness({ files: VALID_FILES, replies: [ok(LIVE_BODY)] });
    await tracker.snapshot();
    expect(requests).toEqual([
      {
        url: USAGE_URL,
        headers: {
          Authorization: "Bearer test-token",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": `claude-cli/${TESTED_CLAUDE_CLI_VERSION} (external, cli)`,
        },
      },
    ]);
  });

  it("reads an expiresAt given in epoch seconds", async () => {
    const { tracker, requests } = harness({
      files: { [CREDENTIALS]: credentials(Math.floor(T0 / 1000) + 3600) },
      replies: [ok(LIVE_BODY)],
    });
    await tracker.snapshot();
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["epoch seconds, 30 s ahead", Math.floor(T0 / 1000) + 30],
    ["epoch ms, 30 s ahead", T0 + 30_000],
    ["epoch ms, already past", T0 - 1_000],
  ])("makes no request when the token expires within 60 s (%s)", async (_label, expiresAt) => {
    const { tracker, requests } = harness({ files: { [CREDENTIALS]: credentials(expiresAt) }, replies: [ok(LIVE_BODY)] });
    const body = await tracker.snapshot();
    expect(requests).toHaveLength(0);
    expect(body.otterly.live_error).toMatch(/^access token expires at /);
    expect(body.otterly.source).toBe("none");
  });

  it("makes no request when there is no access token", async () => {
    const { tracker, requests } = harness({
      files: { [CREDENTIALS]: credentials(T0 + HOUR, null) },
      replies: [ok(LIVE_BODY)],
    });
    const body = await tracker.snapshot();
    expect(requests).toHaveLength(0);
    expect(body.otterly.live_error).toBe("no access token in the credentials file");
  });

  it("looks in ~/.claude and ~/.claude.json when CLAUDE_CONFIG_DIR is unset", async () => {
    const { tracker, requests } = harness({
      files: {
        "/home/test/.claude/.credentials.json": credentials(T0 + HOUR),
        "/home/test/.claude.json": CLAUDE_JSON_BODY,
      },
      replies: [ok(LIVE_BODY)],
      deps: { env: {} },
    });
    const body = await tracker.snapshot();
    expect(requests).toHaveLength(1);
    expect(body.otterly.config_dir).toBe("/home/test/.claude");
    expect(body.otterly.account).toMatchObject({ email: "someone@example.com", organization: "Example Org" });
  });

  it("reuses a successful body for 5 minutes; refresh skips the reuse", async () => {
    const { tracker, requests, advance } = harness({
      files: VALID_FILES,
      replies: [ok(LIVE_BODY), ok(LIVE_BODY), ok(LIVE_BODY)],
    });
    await tracker.snapshot();
    advance(LIVE_REUSE_MS - 1);
    await tracker.snapshot();
    expect(requests).toHaveLength(1);
    await tracker.snapshot({ refresh: true });
    expect(requests).toHaveLength(2);
    advance(LIVE_REUSE_MS);
    await tracker.snapshot();
    expect(requests).toHaveLength(3);
  });

  it("shares one request between concurrent snapshots", async () => {
    const { tracker, requests } = harness({ files: VALID_FILES, replies: [ok(LIVE_BODY), ok(LIVE_BODY)] });
    const [a, b] = await Promise.all([tracker.snapshot(), tracker.snapshot()]);
    expect(requests).toHaveLength(1);
    expect(a.five_hour).toEqual(LIVE_BODY.five_hour);
    expect(b.five_hour).toEqual(LIVE_BODY.five_hour);
  });

  it("backs off 5 minutes after HTTP 429 when Retry-After is shorter; refresh does not shorten it", async () => {
    const { tracker, requests, advance } = harness({
      files: VALID_FILES,
      replies: [ok(LIVE_BODY), fail(429, { "retry-after": "30" }), ok(LIVE_BODY)],
    });
    await tracker.snapshot();
    advance(LIVE_REUSE_MS);
    let body = await tracker.snapshot();
    expect(requests).toHaveLength(2);
    expect(body.otterly.live_error).toBe("usage endpoint answered HTTP 429; next request after 2026-10-16T12:10:00.000Z");
    // The last good body is kept.
    expect(body.five_hour).toEqual(LIVE_BODY.five_hour);
    expect(body.otterly.source).toBe("oauth_usage");
    advance(LIVE_429_BACKOFF_MS - 1);
    await tracker.snapshot({ refresh: true });
    expect(requests).toHaveLength(2);
    advance(1);
    body = await tracker.snapshot();
    expect(requests).toHaveLength(3);
    expect(body.otterly.live_error).toBeNull();
  });

  it("backs off for Retry-After after HTTP 429 when it is longer than 5 minutes", async () => {
    const { tracker, requests, advance } = harness({
      files: VALID_FILES,
      replies: [fail(429, { "retry-after": "900" }), ok(LIVE_BODY)],
    });
    await tracker.snapshot();
    advance(900_000 - 1);
    await tracker.snapshot({ refresh: true });
    expect(requests).toHaveLength(1);
    advance(1);
    const body = await tracker.snapshot();
    expect(requests).toHaveLength(2);
    expect(body.five_hour).toEqual(LIVE_BODY.five_hour);
  });

  it.each([
    ["HTTP 500", fail(500), "usage endpoint answered HTTP 500"],
    ["a network error", networkError, "usage request failed: fetch failed"],
    [
      "a body that is not JSON",
      (() => new Response("<html>", { status: 200 })) as Reply,
      "usage endpoint answered with something other than a JSON object",
    ],
  ])("backs off 60 s after %s", async (_label, reply, error) => {
    const { tracker, requests, advance } = harness({ files: VALID_FILES, replies: [reply, ok(LIVE_BODY)] });
    let body = await tracker.snapshot();
    expect(body.otterly.live_error).toBe(error);
    expect(Object.keys(body)).toEqual(["otterly"]);
    advance(LIVE_FAILURE_BACKOFF_MS - 1);
    await tracker.snapshot({ refresh: true });
    expect(requests).toHaveLength(1);
    advance(1);
    body = await tracker.snapshot();
    expect(requests).toHaveLength(2);
    expect(body.otterly.source).toBe("oauth_usage");
  });
});

describe("QuotaTracker: the credentials are only read", () => {
  it("writes nothing to the config dir, whatever the outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otterly-quota-"));
    try {
      writeFileSync(join(dir, ".credentials.json"), credentials(T0 + 24 * HOUR));
      writeFileSync(join(dir, ".claude.json"), CLAUDE_JSON_BODY);
      const state = () =>
        readdirSync(dir)
          .sort()
          .map((name) => {
            const path = join(dir, name);
            return { name, bytes: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
          });
      const before = state();
      let now = T0;
      const replies: Reply[] = [ok(LIVE_BODY), fail(429), fail(500)];
      // The real file reader: only the clock and the endpoint are fakes.
      const tracker = new QuotaTracker({
        fetch: async () => replies.shift()!(),
        now: () => now,
        env: { CLAUDE_CONFIG_DIR: dir },
      });
      await tracker.snapshot(); // a good body
      tracker.recordRateLimitEvent(EVENT_INFO);
      now += LIVE_REUSE_MS;
      await tracker.snapshot(); // HTTP 429
      now += LIVE_429_BACKOFF_MS;
      await tracker.snapshot(); // HTTP 500
      now += 24 * HOUR; // the token has expired
      const body = await tracker.snapshot();
      expect(replies).toHaveLength(0);
      expect(body.otterly.live_error).toMatch(/^access token expires at /);
      expect(body.otterly.account).toMatchObject({ email: "someone@example.com" });
      expect(state()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("QuotaTracker: usage limit", () => {
  // EVENT_INFO, rejected: the five_hour window binds until FIVE_HOUR_RESET,
  // 2.5 hours after T0.
  const REJECTED = { ...EVENT_INFO, status: "rejected" };
  const UNTIL = Date.parse(FIVE_HOUR_RESET);

  it("starts unlimited", async () => {
    const { tracker } = harness();
    expect(tracker.usageLimit()).toBeNull();
    expect((await tracker.snapshot()).otterly.limited_until).toBeNull();
  });

  it("is limited until resetsAt after a rejected event", async () => {
    const { tracker } = harness();
    tracker.recordRateLimitEvent(REJECTED);
    expect(tracker.usageLimit()).toEqual({ until: UNTIL, type: "five_hour", retryAfterS: 9000 });
    expect((await tracker.snapshot()).otterly).toMatchObject({ status: "rejected", limited_until: FIVE_HOUR_RESET });
  });

  it("lifts at resetsAt, rounding Retry-After up to whole seconds until then", async () => {
    const { tracker, advance } = harness();
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
    const { tracker, advance } = harness();
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
    const { tracker, advance } = harness();
    tracker.recordRateLimitEvent(REJECTED);
    advance(60_000);
    tracker.recordRateLimitEvent({ ...EVENT_INFO, status });
    expect(tracker.usageLimit()).toBeNull();
    expect((await tracker.snapshot()).otterly.limited_until).toBeNull();
  });

  it("is forgotten by reset", () => {
    const { tracker } = harness();
    tracker.recordRateLimitEvent(REJECTED);
    tracker.reset();
    expect(tracker.usageLimit()).toBeNull();
  });
});
