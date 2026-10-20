// Usage of the Claude subscription that the claude CLI is logged in to, for
// GET /api/quota and the blocked-inference gate, in the shape of Anthropic's
// own usage endpoint; and the account's usage limit, which index.ts answers
// with HTTP 429 (usageLimit).
//
// Every figure comes from the claude CLI itself. Otterly reads none of the
// CLI's files and contacts no address on its behalf. Three sources:
//   - rate_limit_event lines, which the CLI prints after each API response.
//     createCLIQueryFn in engine.ts passes every one to recordRateLimitEvent.
//   - `claude -p /usage`, run when GET /api/quota or the blocked-inference gate
//     needs it. It prints a usage_report and makes no model call.
//   - `claude auth status`, which says who the CLI is logged in as.

import { homedir } from "os";
import { join } from "path";
// engine.ts imports this module as well. These bindings are used only inside
// methods, never while either module is loading, so the cycle is harmless.
import { findClaudeCLI, spawnWithAbort } from "../engine.js";

/** A good /usage result is reused for this long. */
export const LIVE_REUSE_MS = 5 * 60 * 1000;
/** /usage never runs more often than this, ?refresh=1 included. */
export const USAGE_MIN_INTERVAL_MS = 60 * 1000;
/** After a failed /usage run, no run for this long. */
export const LIVE_FAILURE_BACKOFF_MS = 60 * 1000;
/** A /usage run is stopped after this long. */
export const USAGE_TIMEOUT_MS = 60 * 1000;
/** A `claude auth status` answer is reused for this long. */
export const ACCOUNT_REUSE_MS = 30 * 60 * 1000;
/** A `claude auth status` run is stopped after this long. */
export const AUTH_TIMEOUT_MS = 30 * 1000;
/** A usage limit whose rate_limit_event gives no resetsAt lasts this long. */
export const LIMIT_HOLD_MS = 5 * 60 * 1000;

/** The windows of the response that a rate_limit_event can update. */
const EVENT_WINDOWS = ["five_hour", "seven_day"];
/** The usage_report limit kinds that become windows of the response. */
const LIMIT_WINDOWS = new Map([["session", "five_hour"], ["weekly_all", "seven_day"]]);

/** The argv of one `claude -p /usage` run: no tools, settings or MCP servers. */
export function usageArgv(cli: string): string[] {
  return [cli, "-p", "/usage", "--output-format", "stream-json", "--verbose", "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"];
}

/** The argv of one `claude auth status` run. */
export function authStatusArgv(cli: string): string[] {
  return [cli, "auth", "status"];
}

/** One window, as Anthropic's usage endpoint reports it. */
export interface QuotaWindow {
  /** Percentage, 0-100. */
  utilization: number;
  /** ISO-8601; null when unknown, or once the window has reset. */
  resets_at: string | null;
}

/** Who the claude CLI is logged in as, from `claude auth status`. */
export interface QuotaAccount {
  email: string | null;
  organization: string | null;
  subscription_type: string | null;
  rate_limit_tier: string | null;
}

/** The `otterly` key of GET /api/quota. */
export interface QuotaInfo {
  /** What supplied the newest five_hour figure. */
  source: "usage_command" | "rate_limit_event" | "none";
  /** When that figure was observed. */
  observed_at: string | null;
  /** status of the latest rate_limit_event: allowed, allowed_warning or rejected. */
  status: string | null;
  /** While the account is at its usage limit, when the limit lifts (ISO-8601); otherwise null. */
  limited_until: string | null;
  /** Why the last `claude /usage` run was skipped or failed. */
  live_error: string | null;
  /** The claude CLI's config dir, as a string; nothing in it is read. */
  config_dir: string;
  account: QuotaAccount | null;
}

/** The body of GET /api/quota: the usage windows, plus `otterly`. */
export type QuotaSnapshot = Record<string, unknown> & { otterly: QuotaInfo };

/** The usage limit of the Claude account, while it lasts. */
export interface UsageLimit {
  /** When the limit lifts, epoch ms. */
  until: number;
  /** The window that binds: the event's rateLimitType, or "unknown" when it names none. */
  type: string;
  /** Seconds until the limit lifts, rounded up, at least 1: the Retry-After value. */
  retryAfterS: number;
}

/** Runs one claude CLI command, with stdin closed and Otterly's environment,
 *  and resolves with its stdout. Rejects when the command cannot start, exits
 *  non-zero or times out. */
export type QuotaRunner = (argv: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<string>;

/** Everything QuotaTracker takes from outside. Tests replace any of it. */
export interface QuotaDeps {
  run: QuotaRunner;
  /** Path of the claude CLI, or null when there is none. */
  findCli: () => string | null;
  /** Epoch ms. */
  now: () => number;
  env: Record<string, string | undefined>;
  homeDir: () => string;
}

export class QuotaTracker {
  private readonly deps: QuotaDeps;
  /** Each window from rate_limit_events, with the time it was observed. */
  private readonly eventWindows = new Map<string, { window: QuotaWindow; at: number }>();
  /** status of the latest rate_limit_event. */
  private eventStatus: string | null = null;
  /** Set while the latest rate_limit_event is rejected: when the limit lifts
   *  (epoch ms) and the window that binds. */
  private limit: { until: number; type: string; generation: number } | null = null;
  /** Provenance generation of the latest valid rate_limit_event. */
  private eventGeneration = 0;
  /** The last good /usage result, mapped, and when it arrived. */
  private live: { body: Record<string, unknown>; at: number } | null = null;
  /** Why the last /usage run was skipped or failed; null after a success. */
  private liveError: string | null = null;
  /** When the last /usage run started (epoch ms). */
  private lastRunAt: number | null = null;
  /** No /usage run before this time (epoch ms): the hold after a failure. */
  private noRunBefore = 0;
  /** The /usage run in flight. Concurrent snapshots wait for it. */
  private pending: Promise<void> | null = null;
  /** What the last `claude auth status` said; null when it failed. */
  private accountInfo: QuotaAccount | null = null;
  /** When the last `claude auth status` run started (epoch ms). */
  private accountAt: number | null = null;
  /** The `claude auth status` run in flight. Concurrent snapshots wait for it. */
  private accountPending: Promise<void> | null = null;

  constructor(deps: Partial<QuotaDeps> = {}) {
    this.deps = {
      run: (argv, o) => spawnWithAbort(argv, { cwd: o.cwd, timeoutMs: o.timeoutMs }),
      findCli: () => findClaudeCLI()?.path ?? null,
      now: () => Date.now(),
      env: process.env,
      homeDir: () => homedir(),
      ...deps,
    };
  }

  /**
   * Record the rate_limit_info of one rate_limit_event line: each window's
   * utilization (a fraction) as a percentage rounded to 2 decimals, its
   * resetsAt (epoch seconds) as an ISO string, and the event's status. A
   * rejected event starts the usage limit, which lasts until its resetsAt or,
   * when it has none, for LIMIT_HOLD_MS; an event with any other status ends
   * it. Never throws, since it runs inside every CLI run.
   */
  recordRateLimitEvent(info: unknown): void {
    if (!isObject(info)) return;
    const at = this.deps.now();
    this.eventGeneration++;
    this.eventStatus = stringField(info, "status");
    if (this.eventStatus === "rejected") {
      const resetsAt = info.resetsAt;
      this.limit = {
        until: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt * 1000 : at + LIMIT_HOLD_MS,
        type: stringField(info, "rateLimitType") ?? "unknown",
        generation: this.eventGeneration,
      };
    } else {
      this.limit = null;
    }
    for (const [name, value] of Object.entries(objectField(info, "unifiedWindows"))) {
      if (!isObject(value)) continue;
      const fraction = value.utilization;
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
      this.eventWindows.set(name, {
        window: { utilization: Math.round(fraction * 10_000) / 100, resets_at: isoFromEpoch(value.resetsAt, 1000) },
        at,
      });
    }
  }

  /** The claude CLI's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. Only
   *  reported; nothing in it is read. */
  configDir(): string {
    return this.deps.env.CLAUDE_CONFIG_DIR || join(this.deps.homeDir(), ".claude");
  }

  /**
   * The usage limit while the account is at it: the latest rate_limit_event
   * was rejected and the limit has not yet lifted. Null otherwise.
   */
  usageLimit(): UsageLimit | null {
    const now = this.deps.now();
    if (!this.limit || now >= this.limit.until) return null;
    return {
      until: this.limit.until,
      type: this.limit.type,
      retryAfterS: Math.max(1, Math.ceil((this.limit.until - now) / 1000)),
    };
  }

  /**
   * The body of GET /api/quota. Runs `claude auth status` and `claude -p
   * /usage` first when they are due (maybeReadAccount, maybeReadUsage);
   * `refresh` skips the reuse of their last answers. `cwd` is the working
   * directory they run in. Never throws.
   */
  async snapshot(opts: { refresh?: boolean; cwd?: string } = {}): Promise<QuotaSnapshot> {
    const refresh = opts.refresh === true;
    await Promise.all([
      this.maybeReadAccount(refresh, opts.cwd).catch(() => {
        this.accountInfo = null;
      }),
      this.maybeReadUsage(refresh, opts.cwd).catch((err) => {
        this.liveError = `claude /usage failed: ${clip(errorMessage(err))}`;
      }),
    ]);
    return this.compose(this.configDir());
  }

  /** Refresh an active usage limit from /usage without reading auth status. */
  async refreshLimit(cwd?: string): Promise<UsageLimit | null> {
    if (this.usageLimit()) {
      await this.maybeReadUsage(false, cwd).catch((err) => {
        this.liveError = `claude /usage failed: ${clip(errorMessage(err))}`;
      });
    }
    return this.usageLimit();
  }

  /** Forget every figure, hold and account. For tests. */
  reset(): void {
    this.eventWindows.clear();
    this.eventStatus = null;
    this.eventGeneration = 0;
    this.limit = null;
    this.live = null;
    this.liveError = null;
    this.lastRunAt = null;
    this.noRunBefore = 0;
    this.pending = null;
    this.accountInfo = null;
    this.accountAt = null;
    this.accountPending = null;
  }

  /**
   * Run /usage unless a run is in flight (it is shared), the hold after a
   * failure is running, the last run started under USAGE_MIN_INTERVAL_MS ago,
   * or the last good result is under LIVE_REUSE_MS old (`refresh` skips only
   * this last check when the account is not limited).
   */
  private async maybeReadUsage(refresh: boolean, cwd?: string): Promise<void> {
    if (this.pending) {
      await this.pending;
      return;
    }
    const now = this.deps.now();
    if (now < this.noRunBefore) return;
    if (this.lastRunAt !== null && now - this.lastRunAt < USAGE_MIN_INTERVAL_MS) return;
    if (!refresh && !this.usageLimit() && this.live && now - this.live.at < LIVE_REUSE_MS) return;
    this.lastRunAt = now;
    const generation = this.eventGeneration;
    this.pending = this.readUsage(cwd, generation).finally(() => {
      this.pending = null;
    });
    await this.pending;
  }

  /** One run of `claude -p /usage`, or the reason none was made. */
  private async readUsage(cwd: string | undefined, generation: number): Promise<void> {
    const cli = this.deps.findCli();
    if (!cli) {
      this.fail("claude CLI not found on PATH");
      return;
    }
    let stdout: string;
    try {
      stdout = await this.deps.run(usageArgv(cli), { cwd, timeoutMs: USAGE_TIMEOUT_MS });
    } catch (err) {
      this.fail(`claude /usage failed: ${clip(errorMessage(err))}`);
      return;
    }
    const parsed = parseUsageOutput(stdout);
    if ("problem" in parsed) {
      this.fail(parsed.problem);
      return;
    }
    this.live = { body: parsed.body, at: this.deps.now() };
    this.liveError = null;
    this.noRunBefore = 0;
    if (this.limit && this.deps.now() < this.limit.until && this.limit.generation === generation && (this.limit.type === "five_hour" || this.limit.type === "seven_day")) {
      const window = parsed.body[this.limit.type];
      if (isObject(window) && typeof window.utilization === "number" && Number.isFinite(window.utilization) && window.utilization >= 0 && window.utilization < 100) {
        this.limit = null;
      }
    }
  }

  private fail(reason: string): void {
    this.noRunBefore = this.deps.now() + LIVE_FAILURE_BACKOFF_MS;
    this.liveError = reason;
  }

  /**
   * Run `claude auth status`, unless a run is in flight (it is shared), the
   * last run started under USAGE_MIN_INTERVAL_MS ago, or under
   * ACCOUNT_REUSE_MS ago (`refresh` skips only this last check).
   */
  private async maybeReadAccount(refresh: boolean, cwd?: string): Promise<void> {
    if (this.accountPending) {
      await this.accountPending;
      return;
    }
    const now = this.deps.now();
    if (this.accountAt !== null) {
      const age = now - this.accountAt;
      if (age < USAGE_MIN_INTERVAL_MS) return;
      if (!refresh && age < ACCOUNT_REUSE_MS) return;
    }
    this.accountAt = now;
    this.accountPending = this.readAccount(cwd).finally(() => {
      this.accountPending = null;
    });
    await this.accountPending;
  }

  /** One run of `claude auth status`; the account is null when it fails. */
  private async readAccount(cwd?: string): Promise<void> {
    const cli = this.deps.findCli();
    if (!cli) {
      this.accountInfo = null;
      return;
    }
    try {
      this.accountInfo = parseAuthStatus(await this.deps.run(authStatusArgv(cli), { cwd, timeoutMs: AUTH_TIMEOUT_MS }));
    } catch {
      this.accountInfo = null;
    }
  }

  private compose(configDir: string): QuotaSnapshot {
    const now = this.deps.now();
    // Start from the last good /usage result.
    const body: Record<string, unknown> = this.live ? structuredClone(this.live.body) : {};
    let source: QuotaInfo["source"] = "none";
    let observedAt: number | null = null;
    if (this.live && isObject(body.five_hour)) {
      source = "usage_command";
      observedAt = this.live.at;
    }
    // A rate_limit_event observed after that result has the newer figures for
    // its windows.
    for (const name of EVENT_WINDOWS) {
      const recorded = this.eventWindows.get(name);
      if (!recorded || (this.live && recorded.at <= this.live.at)) continue;
      body[name] = { ...objectField(body, name), ...recorded.window };
      if (name === "five_hour") {
        source = "rate_limit_event";
        observedAt = recorded.at;
      }
    }
    // A window whose reset time has passed no longer carries any usage.
    for (const [name, value] of Object.entries(body)) {
      if (!isObject(value)) continue;
      const resetsAt = Date.parse(stringField(value, "resets_at") ?? "");
      if (Number.isFinite(resetsAt) && resetsAt <= now) body[name] = { ...value, utilization: 0, resets_at: null };
    }
    const limit = this.usageLimit();
    const otterly: QuotaInfo = {
      source,
      observed_at: observedAt === null ? null : isoFromEpoch(observedAt, 1),
      status: this.eventStatus,
      limited_until: limit ? isoFromEpoch(limit.until, 1) : null,
      live_error: this.liveError,
      config_dir: configDir,
      account: this.accountInfo,
    };
    return { ...body, otterly };
  }
}

/**
 * The stdout of `claude -p /usage --output-format stream-json`, mapped from the
 * first line carrying usage_report.rate_limits: the limits[] entry of kind
 * "session" becomes five_hour and "weekly_all" becomes seven_day (percent as
 * utilization, resets_at as ISO-8601 with Z); limits and extra_usage are
 * passed through whole. When no line carries it, the reason, with the text of
 * the result line if there is one.
 */
export function parseUsageOutput(stdout: string): { body: Record<string, unknown> } | { problem: string } {
  let resultText: string | null = null;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObject(value)) continue;
    const rateLimits = objectField(value, "usage_report").rate_limits;
    if (isObject(rateLimits)) return { body: mapRateLimits(rateLimits) };
    if (value.type === "result" && resultText === null) resultText = stringField(value, "result");
  }
  return {
    problem: resultText
      ? `claude /usage printed no usage_report: ${clip(resultText)}`
      : "claude /usage printed no usage_report",
  };
}

function mapRateLimits(rateLimits: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const limits = Array.isArray(rateLimits.limits) ? rateLimits.limits : [];
  for (const entry of limits) {
    if (!isObject(entry) || typeof entry.kind !== "string") continue;
    const name = LIMIT_WINDOWS.get(entry.kind);
    if (!name || name in body) continue;
    const percent = entry.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    body[name] = { utilization: percent, resets_at: isoFromString(entry.resets_at) };
  }
  if (Array.isArray(rateLimits.limits)) body.limits = rateLimits.limits;
  if (isObject(rateLimits.extra_usage)) body.extra_usage = rateLimits.extra_usage;
  return body;
}

/**
 * The stdout of `claude auth status` as the account: email, orgName,
 * subscriptionType and rateLimitTier, null for each one absent. Null when it
 * is not a JSON object or says loggedIn: false.
 */
export function parseAuthStatus(stdout: string): QuotaAccount | null {
  let value: unknown = null;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObject(value) || value.loggedIn === false) return null;
  return {
    email: stringField(value, "email"),
    organization: stringField(value, "orgName"),
    subscription_type: stringField(value, "subscriptionType"),
    rate_limit_tier: stringField(value, "rateLimitTier"),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** obj[key] when it is an object, else an empty one. */
function objectField(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return isObject(value) ? value : {};
}

/** obj[key] when it is a non-empty string, else null. */
function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** An epoch time in units of `unitMs` as ISO-8601; null when unusable. */
function isoFromEpoch(value: unknown, unitMs: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * unitMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A date string, fractions beyond milliseconds dropped, as ISO-8601 with Z;
 *  null when unusable. */
function isoFromString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Text trimmed and cut to `max` characters. */
function clip(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** The tracker that GET /api/quota serves and createCLIQueryFn feeds. */
export const quota = new QuotaTracker();
