// Usage of the Claude subscription that the claude CLI is logged in to, for
// GET /api/quota, in the shape of Anthropic's own usage endpoint.
//
// Two sources feed it:
//   - rate_limit_event lines, which the CLI prints after each API response.
//     createCLIQueryFn in engine.ts passes every one to recordRateLimitEvent.
//   - Anthropic's usage endpoint, called with the CLI's own access token.
//
// The credentials file is only ever read. Renewing the token here would rotate
// the refresh token and log the CLI out, so renewal is left to the CLI, which
// does it itself when it next starts a run.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
// engine.ts imports this module as well. These bindings are used only inside
// methods, never while either module is loading, so the cycle is harmless.
import { findClaudeCLI, cliSemver, TESTED_CLAUDE_CLI_VERSION } from "../engine.js";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** A successful usage-endpoint body is reused for this long. */
export const LIVE_REUSE_MS = 5 * 60 * 1000;
/** After HTTP 429, no request for the longer of Retry-After and this. */
export const LIVE_429_BACKOFF_MS = 5 * 60 * 1000;
/** After any other failure, no request for this long. */
export const LIVE_FAILURE_BACKOFF_MS = 60 * 1000;
/** A usage request is abandoned after this long. */
export const LIVE_TIMEOUT_MS = 10 * 1000;
/** A token that expires within this long is treated as expired. */
export const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

/** The windows of the response that a rate_limit_event can update. */
const EVENT_WINDOWS = ["five_hour", "seven_day"];

/** One window, as Anthropic's usage endpoint reports it. */
export interface QuotaWindow {
  /** Percentage, 0-100. */
  utilization: number;
  /** ISO-8601; null when unknown, or once the window has reset. */
  resets_at: string | null;
}

/** Who the claude CLI is logged in as. */
export interface QuotaAccount {
  email: string | null;
  organization: string | null;
  subscription_type: string | null;
  rate_limit_tier: string | null;
}

/** The `otterly` key of GET /api/quota. */
export interface QuotaInfo {
  /** What supplied the newest five_hour figure. */
  source: "oauth_usage" | "rate_limit_event" | "none";
  /** When that figure was observed. */
  observed_at: string | null;
  /** status of the latest rate_limit_event: allowed, allowed_warning or rejected. */
  status: string | null;
  /** Why the last live read was skipped or failed. */
  live_error: string | null;
  /** The claude CLI's config dir. */
  config_dir: string;
  account: QuotaAccount | null;
}

/** The body of GET /api/quota: the usage endpoint's keys, plus `otterly`. */
export type QuotaSnapshot = Record<string, unknown> & { otterly: QuotaInfo };

/** One request to the usage endpoint. */
export type QuotaFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/** Everything QuotaTracker takes from outside. Tests replace any of it. */
export interface QuotaDeps {
  /** Read a UTF-8 file; throws when it cannot. */
  readFile: (path: string) => string;
  fetch: QuotaFetch;
  /** Epoch ms. */
  now: () => number;
  env: Record<string, string | undefined>;
  homeDir: () => string;
}

type JsonFile =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; problem: string };

export class QuotaTracker {
  private readonly deps: QuotaDeps;
  /** Each window from rate_limit_events, with the time it was observed. */
  private readonly eventWindows = new Map<string, { window: QuotaWindow; at: number }>();
  /** status of the latest rate_limit_event. */
  private eventStatus: string | null = null;
  /** The last good usage-endpoint body, and when it arrived. */
  private live: { body: Record<string, unknown>; at: number } | null = null;
  /** Why the last live read was skipped or failed; null after a success. */
  private liveError: string | null = null;
  /** No usage request before this time (epoch ms): the back-off. */
  private noRequestBefore = 0;
  /** The usage request in flight. Concurrent snapshots wait for it. */
  private pending: Promise<void> | null = null;

  constructor(deps: Partial<QuotaDeps> = {}) {
    this.deps = {
      readFile: (path) => readFileSync(path, "utf8"),
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      env: process.env,
      homeDir: () => homedir(),
      ...deps,
    };
  }

  /**
   * Record the rate_limit_info of one rate_limit_event line: each window's
   * utilization (a fraction) as a percentage rounded to 2 decimals, its
   * resetsAt (epoch seconds) as an ISO string, and the event's status. Never
   * throws, since it runs inside every CLI run.
   */
  recordRateLimitEvent(info: unknown): void {
    if (!isObject(info)) return;
    const at = this.deps.now();
    this.eventStatus = stringField(info, "status");
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

  /** The claude CLI's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. */
  configDir(): string {
    return this.deps.env.CLAUDE_CONFIG_DIR || join(this.deps.homeDir(), ".claude");
  }

  /**
   * The body of GET /api/quota. The usage endpoint is read first, unless its
   * last body is under LIVE_REUSE_MS old (`refresh` skips that reuse) or a
   * back-off is running. Never throws.
   */
  async snapshot(opts: { refresh?: boolean } = {}): Promise<QuotaSnapshot> {
    const configDir = this.configDir();
    const credentials = this.readJson(join(configDir, ".credentials.json"));
    try {
      await this.maybeReadLive(credentials, opts.refresh === true);
    } catch (err) {
      this.liveError = `usage read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return this.compose(configDir, credentials);
  }

  /** Forget every figure and back-off. For tests. */
  reset(): void {
    this.eventWindows.clear();
    this.eventStatus = null;
    this.live = null;
    this.liveError = null;
    this.noRequestBefore = 0;
    this.pending = null;
  }

  private async maybeReadLive(credentials: JsonFile, refresh: boolean): Promise<void> {
    const now = this.deps.now();
    if (now < this.noRequestBefore) return;
    if (!refresh && this.live && now - this.live.at < LIVE_REUSE_MS) return;
    this.pending ??= this.readLive(credentials).finally(() => {
      this.pending = null;
    });
    await this.pending;
  }

  /** One read of the usage endpoint, or the reason none was made. */
  private async readLive(credentials: JsonFile): Promise<void> {
    if (!credentials.ok) {
      this.liveError = credentials.problem;
      return;
    }
    const oauth = objectField(credentials.value, "claudeAiOauth");
    const token = stringField(oauth, "accessToken");
    if (!token) {
      this.liveError = "no access token in the credentials file";
      return;
    }
    // expiresAt is epoch seconds or epoch ms, depending on what wrote it.
    const expires = oauth.expiresAt;
    if (typeof expires === "number" && Number.isFinite(expires)) {
      const expiresMs = expires < 1e12 ? expires * 1000 : expires;
      if (expiresMs - this.deps.now() <= TOKEN_EXPIRY_MARGIN_MS) {
        this.liveError = `access token expires at ${isoFromEpoch(expiresMs, 1)}; the claude CLI renews it on its next run`;
        return;
      }
    }

    let res: Response;
    try {
      res = await this.deps.fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": `claude-cli/${cliSemver(findClaudeCLI()?.version ?? "") || TESTED_CLAUDE_CLI_VERSION} (external, cli)`,
        },
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
    } catch (err) {
      this.backOff(LIVE_FAILURE_BACKOFF_MS, `usage request failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (res.status === 429) {
      // The endpoint rate-limits hard; asking again early only extends the wait.
      const waitMs = Math.max(retryAfterMs(res.headers.get("retry-after"), this.deps.now()), LIVE_429_BACKOFF_MS);
      this.backOff(waitMs, `usage endpoint answered HTTP 429; next request after ${isoFromEpoch(this.deps.now() + waitMs, 1)}`);
      return;
    }
    if (!res.ok) {
      this.backOff(LIVE_FAILURE_BACKOFF_MS, `usage endpoint answered HTTP ${res.status}`);
      return;
    }
    let body: unknown = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      // Reported just below.
    }
    if (!isObject(body)) {
      this.backOff(LIVE_FAILURE_BACKOFF_MS, "usage endpoint answered with something other than a JSON object");
      return;
    }
    this.live = { body, at: this.deps.now() };
    this.liveError = null;
    this.noRequestBefore = 0;
  }

  private backOff(ms: number, reason: string): void {
    this.noRequestBefore = this.deps.now() + ms;
    this.liveError = reason;
  }

  private compose(configDir: string, credentials: JsonFile): QuotaSnapshot {
    const now = this.deps.now();
    // Start from the last good live body, passed through whole.
    const body: Record<string, unknown> = this.live ? structuredClone(this.live.body) : {};
    let source: QuotaInfo["source"] = "none";
    let observedAt: number | null = null;
    if (this.live && isObject(body.five_hour)) {
      source = "oauth_usage";
      observedAt = this.live.at;
    }
    // A rate_limit_event observed after that body has the newer figures for
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
    const otterly: QuotaInfo = {
      source,
      observed_at: observedAt === null ? null : isoFromEpoch(observedAt, 1),
      status: this.eventStatus,
      live_error: this.liveError,
      config_dir: configDir,
      account: this.account(configDir, credentials),
    };
    return { ...body, otterly };
  }

  /** Who the CLI is logged in as; null when neither file says. */
  private account(configDir: string, credentials: JsonFile): QuotaAccount | null {
    const oauth: Record<string, unknown> = credentials.ok ? objectField(credentials.value, "claudeAiOauth") : {};
    // .claude.json is inside $CLAUDE_CONFIG_DIR when that is set, otherwise
    // directly in the home directory.
    const claudeJson = this.readJson(
      this.deps.env.CLAUDE_CONFIG_DIR ? join(configDir, ".claude.json") : join(this.deps.homeDir(), ".claude.json"),
    );
    const who: Record<string, unknown> = claudeJson.ok ? objectField(claudeJson.value, "oauthAccount") : {};
    const account: QuotaAccount = {
      email: stringField(who, "emailAddress"),
      organization: stringField(who, "organizationName"),
      subscription_type: stringField(oauth, "subscriptionType"),
      rate_limit_tier: stringField(oauth, "rateLimitTier"),
    };
    return Object.values(account).some((v) => v !== null) ? account : null;
  }

  private readJson(path: string): JsonFile {
    let raw: string;
    try {
      raw = this.deps.readFile(path);
    } catch {
      return { ok: false, problem: `cannot read ${path}` };
    }
    let value: unknown = null;
    try {
      value = JSON.parse(raw);
    } catch {
      // The parser's message quotes the file, which may hold a token, so it
      // is never passed on.
    }
    return isObject(value) ? { ok: true, value } : { ok: false, problem: `${path} is not a JSON object` };
  }
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

/** Retry-After, in seconds or as an HTTP date, as ms from `now`; 0 when absent. */
function retryAfterMs(header: string | null, now: number): number {
  const value = (header ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

/** The tracker that GET /api/quota serves and createCLIQueryFn feeds. */
export const quota = new QuotaTracker();
