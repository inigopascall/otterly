---
verified: 2026-10-18
verified_by: workhorse
---

# Otterly: Architecture

## 0. Document Purpose

This document orients an AI/engineer working on this fork of **Otterly** — an
OpenAI-compatible HTTP shim over the Claude Code CLI. It describes the
architecture, the security model, and the request paths. Read §1–§2 for
orientation, §3 onward for file-level detail.

---

## 1. Birds-Eye Overview

**What Otterly is:** a local server that speaks the OpenAI API. Clients like
**AiderDesk** and **Cherry Studio** send standard OpenAI chat-completion
requests; Otterly fulfils them by driving a locally installed,
already-authenticated Claude Code. This uses a **flat-rate subscription**
instead of per-token API rates.

**Transport:** the `claude` CLI on PATH, and nothing else. Otterly refuses to
start without it (§5).

**Behaviour:**
- Each run is one `claude -p --input-format stream-json --output-format
  stream-json` process. The conversation is written to its stdin as stream-json
  user messages, so large prompts never hit `E2BIG` ("argument list too long").
- Streaming emits incremental text deltas; the final consolidated block is
  suppressed once deltas have been sent.
- A function-calling bridge converts the model's tool-call intent into OpenAI
  `tool_calls`, so clients drive tool execution.
- Every run is isolated unless the caller opts in (§2).
- The CLI runs with `--include-partial-messages --thinking-display summarized`, so
  the model's summarised thinking and its reply arrive as `stream_event` lines
  while they are generated. Streamed responses relay them as
  `reasoning_content` and `content` chunks (§11).
- When `clientToolCalls` is enabled, unexpected native tool inventory or activity
  is rejected; a native `tool_use` block is rejected as soon as it starts. A
  non-streamed request gets HTTP 502; a streamed one has its connection dropped
  so the client retries (§11).

---

## 2. Security Posture

- **Isolation** — `buildCLICommand` in `engine.ts` gives every run:
  - `--tools ""`: no built-in tools, including any a later Claude Code release adds;
  - `--disallowedTools "*"`: a deny rule matching every tool, whatever its source;
  - `--safe-mode`: no CLAUDE.md, hooks, plugins, skills, MCP servers or auto memory;
  - `--setting-sources ""`: no user, project or local settings;
  - `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`: no MCP servers.

  The HTTP routes and `/ws` never opt out. A library caller opts in with `tools`
  (named built-ins, or `["default"]` for Claude Code's default set), which drops
  `--disallowedTools "*"`, or with `mcpServers`, which also drops `--safe-mode`,
  because safe mode stops servers named in `--mcp-config` from loading.
- **Startup check** — before listening, the server runs `verifyClaudeCLI()`: one
  start of the CLI with the default flags and a user message marked
  `shouldQuery: false`, which the CLI records without calling the model, so it
  costs nothing. The server refuses to start if the CLI is missing, exits
  non-zero, or reports any tool or MCP server in its `system/init` message.
  `verifyCli: false` on `startApiServer` skips the check; the tests use it.
- **Native tool activity** — with `clientToolCalls`, unexpected native
  inventory/activity is rejected as soon as it appears: HTTP 502 for a
  non-streamed request, a dropped connection for a streamed one. This is
  detection, not a pre-execution sandbox. `maxTurns` is forwarded to the CLI.
- **Permission handler** — a library caller's `onPermission` answers the CLI's
  `can_use_tool` requests over stdio (§5). Read-only tools such as `Read` may run
  without a request. A request that arrives with no handler set is denied.
- **Unparsed tool-call intent** — a tool-enabled reply that cannot be parsed or
  repaired into OpenAI `tool_calls` is rejected rather than returned as prose
  (HTTP 502 non-streamed; a dropped connection streamed, §11), when it shows
  tool-call intent: the `{`"tool_calls"`: …}`
  envelope, or `<invoke name="X">` markup where `X` is a tool the request
  offered. Markup inside a code fence or an inline code span does not count, so a
  reply that discusses the syntax stays prose. See `looksLikeToolCallIntent` in
  `tool-call-repair.ts`.

### Accepted limitations

- **No temperature control** — the CLI exposes no sampling-temperature flag.
- **History flattening** — Otterly collapses multi-turn history into a single
  prompt (structural to the shim design).

---

## 3. Files (Map)

| File | Role |
|---|---|
| `src/cli.ts` | Parses flags and environment variables; starts the server |
| `src/engine.ts` | Claude engine, CLI command builder, stdio transport, startup check, `spawnWithAbort` and `streamLines` |
| `src/events.ts` | Claude NDJSON → `AgentEvent` parser (`text_delta`, `thinking_delta`) |
| `src/session.ts` | Multi-turn `Session`: one CLI process per conversation (used by `/ws`) |
| `src/permissions.ts` | `wrapPermissionHandler`, `READONLY`, `AUTOPILOT` |
| `src/server/engine-factory.ts` | `makeEngine()` — the engine every HTTP route uses; tests replace it |
| `src/server/routes-openai.ts` | `/v1/chat/completions`; sets `clientToolCalls` |
| `src/server/ws-handler.ts` | `/ws` sessions |
| `src/server/models.ts` | Model catalog |
| `src/server/openai-compat.ts` | OpenAI translation and the tool bridge |
| `src/server/sse-stream.ts` | `SseStream`: the SSE chunks of one streamed completion |
| `src/server/tool-call-stream.ts` | `ToolCallStreamer, reconcileStreamedCalls`: live tool calls |
| `src/server/retry-notice.ts` | Remembers dropped requests; notice on the retry |
| `src/server/quota.ts` | `QuotaTracker` and its singleton `quota`: subscription usage for `GET /api/quota` from `claude -p /usage`, `claude auth status` and `rate_limit_event` lines, and the usage limit (§12) |
| `tests/fixtures/fake-claude.mjs` | A stand-in CLI that speaks stream-json, for `tests/cli-transport.test.ts` |
| `tests-cli/claude-cli.test.ts` | The CLI suite: checks the real installed `claude` (§7) |

---

## 4. Running

    otterly serve -p 11435 -d /path/to/project

With no `-d`, the server uses an empty scratch directory under the system temp
folder (`SCRATCH_DIR`). In a client (e.g. AiderDesk), add an OpenAI-Compatible
provider with base URL `http://localhost:11435/v1`.

`-H`/`--host <address>` sets the interface the server listens on, e.g.
`--host 127.0.0.1`; `startApiServer` takes it as `host`. With no `--host`, the
server listens on all interfaces.

---

## 5. Transport and the Claude CLI

- **Finding the CLI** — `findClaudeCLI()` looks for `claude`, then `claude-code`,
  on PATH, and caches its path and `--version` output. The startup banner's
  `Claude CLI` line shows both. There is no other transport: without a CLI,
  every run fails with `SDK_NOT_FOUND`.
- **One-shot runs** (`/v1/chat/completions`, `/api/run`, `/api/stream`, Ollama
  routes) use `run()`/`stream()`: one user message, and stdin is closed when its
  `result` arrives.
- **`Session`** (library and `/ws`) keeps one CLI process for the whole
  conversation: each `send()` writes the next user message, and the CLI emits
  one `result` per turn. `resume`, on a one-shot run or a session, passes
  `--resume <session id>`.
- **Permission requests** — with a handler set, the CLI runs with
  `--permission-prompt-tool stdio` and sends
  `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name":…,"input":…}}`
  on stdout. `createCLIQueryFn` answers on stdin with
  `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":…}}}`,
  or `"behavior":"deny"` with a `"message"`. This is the protocol the Agent SDK
  uses; `tests/cli-transport.test.ts` and the CLI suite cover it.
- **Tested version** — `TESTED_CLAUDE_CLI_VERSION` in `engine.ts` is the Claude
  Code version the CLI suite last passed against. The banner warns when the
  installed version differs.
- **After a Claude Code upgrade**, run the CLI suite (§7). If it passes, set
  `TESTED_CLAUDE_CLI_VERSION` to the new version. If it fails, go back to the
  previous Claude Code version and open an issue with the failing output.
  `--thinking-display` is absent from the official CLI reference, so it is the
  flag most likely to change; the suite checks it.

## 6. Building and re-deploying the global install

```
cd /home/inigo/code/otterly
pnpm run build
pnpm i -g .
```

## 7. Running tests

Run the Vitest that `package.json` pins, from the repo's own `node_modules`:

```
pnpm exec vitest run
```

`vitest.config.ts` sets `OTTERLY_DISABLE_CLAUDE_CLI=1`, which makes
`findClaudeCLI()` return null, so the default suite never spawns a real
`claude`. Tests fake the CLI by injecting a query function: with
`setQueryFnForTests()`, as the server tests do, or as the second argument of
`new ClaudeEngine()`. `tests/cli-transport.test.ts` drives the stdin/stdout
protocol against `tests/fixtures/fake-claude.mjs`.

The **CLI suite** (`tests-cli/`) checks the real installed `claude`: the
startup check, every flag Otterly can pass (at no cost), and a few short,
low-effort conversations on the subscription (streaming, a two-turn session,
resume, a denied and an approved write). Run it after every Claude Code
upgrade (§5):

```
pnpm exec vitest run --config vitest.cli.config.ts
```

## 8. Request tracing

Set `OTTERLY_TRACE=1` (or `OTTERLY_TRACE_DIR=/some/path`) before starting the
server. The default location is `~/.otterly/traces`.

```
OTTERLY_TRACE=1 otterly serve -p 11435
```

Every structured log line is mirrored to `<dir>/otterly.log`, and each
`/v1/chat/completions` request gets a directory `<dir>/<timestamp>-<requestId>/`
containing:

| File | Contents |
|---|---|
| `request.json` | The OpenAI request body as received |
| `command.txt` | The exact `claude` command line, shell-quoted |
| `prompt.txt` | Every stream-json line written to the CLI's stdin, in order: user messages and answers to permission requests |
| `run-result-event.txt` | Text carried by the `result` line |
| `run-text-blocks.txt` | Concatenation of every assistant text block |
| `run-text-deltas.txt` | Concatenation of every streamed delta |
| `run-final.txt` | The text `run()` chose to return |
| `engine-text.txt` | Engine text entering the function-calling path |
| `unparsed-prose.txt` | A tool-enabled reply returned to the client as prose |
| `unparseable-tool-call.txt` | A reply that failed with 502, or whose stream was dropped |
| `stream-sent.txt` | The reply text written to the SSE stream |
| `stream-reasoning.txt` | The reasoning text written to the SSE stream |
| `sse-out.tsv` | One row per SSE chunk sent: ms since the stream opened, kind (`start`, `reasoning`, `content`, `tool_start`, `tool_args`, `finish:<reason>`, `error:<code>`, `drop`), bytes |
| `response-text.txt` | Exactly what was returned non-streamed |
| `cli-stdout.live.ndjson` | The CLI's stdout lines as they arrived; present even when the run was killed |
| `cli-stderr.txt` | The CLI's stderr as it arrived |
| `cli-timing.tsv` | One row per stdout line: ms since spawn, ms since the previous line, line length, event type |

Comparing `run-text-blocks.txt` against `run-final.txt` and `stream-sent.txt`
locates a missing opening section at a specific stage.

### Where diagnostics go

Diagnostic lines carry prompt and response excerpts, so they are written to
`<dir>/otterly.log` and nowhere else. The server's own console keeps showing
only `request_start` / `request_end` and genuine errors.

Set `OTTERLY_LOG_VERBOSE=1` to mirror diagnostics to the console as well.
Without either variable set, diagnostics are not produced at all.

Log messages worth grepping: `run_text_sources`, `cli_spawn`, `cli_stdout`,
`cli_result_line`, `cli_line_unparsed`, `tool_call_parsed`,
`tool_call_none_parsed`, `tool_call_unparseable`,
`tool_call_unparseable_detail`, `native_tool_call_blocked`,
`native_tool_inventory_detected`, `stream_summary`, `fc_response`,
`response_text`, `cli_timing`, `cli_terminated`, `request_timeout`,
`response_unsettled`, `cli_progress`, `stream_dropped_for_retry`,
`tool_call_repaired`, `request_fingerprint`, `cli_api_error`.

`request_fingerprint` and `stream_dropped_for_retry` carry the same 12-character
`fingerprint` for a request and its retries; `request_fingerprint` also carries
the `attempt` number. `cli_api_error` records an API failure reported by the
CLI (overload, rate limit, safeguard refusal) with its `apiErrorStatus` and the
CLI's own explanation, which is also what the client receives.

`tool_call_unparseable` is the terse console line for a 502; the bytes that
caused it are in `tool_call_unparseable_detail` and in
`unparseable-tool-call.txt`.

At startup and then hourly, trace directories older than 7 days are deleted;
`OTTERLY_TRACE_RETENTION_DAYS` overrides the number of days. `otterly.log` is
rotated to `otterly.log.1` when it reaches 50 MB, keeping three old files
(`pruneTraces` and `rotateLogIfNeeded` in `server/trace.ts`).

## 9. Timeouts and progress

A Claude run is stopped in either of two cases:

- **No output for 5 minutes** (the idle limit). The CLI prints the model's
  thinking and its reply as they are generated, so silence means the run
  has stopped making progress.
- **45 minutes in total** (the hard cap), however much output there is.

Override either, in seconds:

    otterly serve --idle-timeout 600 --request-timeout 3600 --stream-timeout 3600
    OTTERLY_IDLE_TIMEOUT=600 OTTERLY_REQUEST_TIMEOUT=3600 OTTERLY_STREAM_TIMEOUT=3600 otterly serve

`--request-timeout` sets the hard cap for non-streamed requests and
`--stream-timeout` for streamed ones. A flag takes precedence over its
environment variable. The startup banner prints the values in force on its
`Timeouts` line.

When a run is stopped, the client gets an answer:

- non-streamed: HTTP **504** with `"type":"timeout_error"`;
- streamed, hard cap: an error chunk with `"code":504`, then `data: [DONE]`;
- streamed, idle limit: the connection is dropped, which the client retries (§11).

The error message says which limit was hit. The console shows
`request_timeout`. Timeouts do not trip the circuit breaker.

Every 30 s, a running Claude request prints a `cli_progress` line on the
console: `elapsedS`, `lines`, `thinkingTokens`, and `silentS` (seconds since the
CLI last printed anything).

`request_end` always carries an `outcome`: `ok`, `timeout`,
`client_disconnected`, `dropped_for_retry` or `error`. A request whose client
hung up is logged with status 499; a stream Otterly dropped so the client
retries (§11) is logged as `dropped_for_retry` with status 502. If a handler returns without answering, `settleResponse` in
`server/settle.ts` answers for it (504 after a timeout, otherwise 500) and the
console shows `response_unsettled`.

The Claude CLI's own hard timer is set 60 s past the server's hard cap
(`CLI_BACKSTOP_MS` in `engine.ts`), so the server always reports the timeout
first.

A `Session` has no hard cap, since it waits between turns for as long as its
caller does. The idle limit does not count the time it spends waiting for its
next message or for a permission handler's decision.

Claude CLI children run in their own process groups, so Ctrl+C in the server's
terminal does not reach them. On SIGINT or SIGTERM the server sends SIGTERM to
every live child, drains for up to 10 s, then sends SIGKILL (`killAllChildren`
in `engine.ts`).

With tracing on, `cli_timing` records each run's `firstLineMs`, `maxGapMs` and
`peakThinkingTokens`. `cli_terminated` records why a run was stopped
(`aborted`, `timeout`, `idle` or `killed`) and how much output it had produced.

## 10. Reasoning effort

One-shot `/v1/chat/completions` requests default to `medium` reasoning effort.
`reasoning_effort` accepts `low`, `medium`, `high`, `xhigh`, or `max`, which the
CLI receives unchanged. The OpenAI values `none` and `minimal` are forwarded as
`low`, the CLI's lowest level. Any other value returns HTTP 400. The CLI
receives the selected value as `--effort`, visible in each trace's
`command.txt`. Reused sessions retain their construction options. Covered by
`tests/server/reasoning-effort.test.ts`.

## 11. Streamed responses

A streamed `/v1/chat/completions` response (`SseStream` in `sse-stream.ts`)
opens with a `role: "assistant"` chunk, then sends the model's thinking as
`delta.reasoning_content` and its reply as `delta.content` as they are
generated. The last chunk carries `finish_reason` and `usage`, followed by
`data: [DONE]`. After 5 s without a write, a `: keepalive` comment is sent.
AiderDesk shows `reasoning_content` as its collapsible thinking block.

With client `tools`, the reply is classified as it arrives
(`ToolCallStreamer`): prose streams as `content`; in a reply that is a
`{"tool_calls": …}` envelope, each call is sent as its own `tool_calls` entry
as soon as its name is known, and its arguments follow as they are written;
anything that may be tool-call markup is held back until the end. The finished
reply is then parsed as in the non-streamed path, and that parse decides:

- the calls match what was streamed (`reconcileStreamedCalls`):
  `finish_reason: "tool_calls"`;
- the reply is prose: held-back text is sent, `finish_reason: "stop"`;
- the reply shows tool-call intent but cannot be parsed, or the parse disagrees
  with what was streamed: the connection is dropped.

Clients on the AI SDK, AiderDesk among them, retry a dropped connection and
discard the partial reply; they do not retry an HTTP error or an in-stream
error. Otterly therefore drops the connection for an unparseable or
unconfirmed tool call, a native tool call and the idle limit, and sends an
in-stream error for everything else. Each drop is recorded against a
fingerprint of the request's model, messages and tools (`retry-notice.ts`,
kept 10 minutes); the retry's reasoning opens with a notice such as
`⚠️ Otterly: the previous attempt … (attempt 2)`. The console shows
`stream_dropped_for_retry`.

Non-streamed tool requests are buffered, and fail with HTTP 502 as in §2.

## 12. Subscription quota

`GET /api/quota` reports the 5-hour and weekly usage of the Claude subscription
that the `claude` CLI is logged in to (`QuotaTracker` and its singleton `quota`
in `server/quota.ts`). The body has the shape of Anthropic's own usage
endpoint: `five_hour` and `seven_day`, each with `utilization` as a percentage
(0-100) and `resets_at` as ISO-8601, `limits` and `extra_usage` when
`claude /usage` supplied them, plus an `otterly` key holding `source`,
`observed_at`, `status`, `limited_until`, `live_error`, `config_dir` and
`account`. The answer is always HTTP 200; with no data it holds only
`otterly`, with `source: "none"`. When `OTTERLY_API_KEY` is set, the route
needs the bearer token, as the POST routes do, because it names the account;
the other GET routes stay open.

**Every figure comes from the `claude` CLI.** Otterly reads none of the CLI's
files, contacts no Anthropic address, and never identifies itself as the CLI.
`config_dir` is `$CLAUDE_CONFIG_DIR`, or `~/.claude` when that is unset, as a
string only. Three sources feed the body:

- **`rate_limit_event` lines**, which the CLI prints after each API response.
  `createCLIQueryFn` in `engine.ts` passes every one, from one-shot runs and
  `Session`s alike, to `quota.recordRateLimitEvent`, and still yields the line.
  There `utilization` is a fraction and `resetsAt` is in epoch seconds; they
  are stored as a percentage rounded to 2 decimals and as an ISO string.
- **`claude -p /usage`**, run through `spawnWithAbort` (`usageArgv` in
  `server/quota.ts`) with stdin closed, Otterly's own environment (so
  `CLAUDE_CONFIG_DIR` selects the account), the server's working directory,
  and a 60 s timeout (`USAGE_TIMEOUT_MS`):
  `claude -p /usage --output-format stream-json --verbose --safe-mode --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'`.
  It makes no model call. The first stdout line carrying
  `usage_report.rate_limits` is mapped (`parseUsageOutput`): the `limits[]`
  entry of kind `session` becomes `five_hour` and `weekly_all` becomes
  `seven_day` (`percent` as `utilization`, `resets_at` as ISO-8601 with `Z`);
  `limits` and `extra_usage` are passed through whole, so `weekly_scoped`
  entries reach the client.
- **`claude auth status`** (`authStatusArgv`), with the same CLI, environment
  and working directory and a 30 s timeout (`AUTH_TIMEOUT_MS`). Its JSON gives
  `otterly.account`: `email`, `orgName` as `organization`,
  `subscriptionType` as `subscription_type` and `rateLimitTier` as
  `rate_limit_tier`, `null` for each one absent. `account` is `null` when the
  command fails or says `loggedIn: false` (`parseAuthStatus`).

**Merge.** The body starts from the last good `/usage` result. For
`five_hour` and `seven_day`, a `rate_limit_event` observed after that result
replaces `utilization` and `resets_at`. A window whose `resets_at` has passed
is reported as `utilization: 0`, `resets_at: null`.

**When the commands run.** Only when `GET /api/quota` is requested.

- A good `/usage` result is reused for 5 minutes (`LIVE_REUSE_MS`).
  `?refresh=1` skips the reuse, but `/usage` never runs more than once per
  60 s (`USAGE_MIN_INTERVAL_MS`).
- After a failed run (no CLI, a non-zero exit, a timeout, no `usage_report`
  line), none for 60 s (`LIVE_FAILURE_BACKOFF_MS`), `?refresh=1` included.
- Concurrent requests share one run.
- While the account is at its usage limit (below), `/usage` is not run; the
  `rate_limit_event` figures stand.
- `claude auth status` runs at most once per 30 minutes (`ACCOUNT_REUSE_MS`),
  and on `?refresh=1` at most once per 60 s.
- The last good result is kept through failures; `otterly.live_error` says
  why the last `/usage` run was skipped or failed, and is `null` after a
  success.

**At the usage limit.** A `rate_limit_event` with `status: "rejected"` means
the account is at its usage limit. The limit lasts until that event's
`resetsAt`, or for 5 minutes after it when it has none (`LIMIT_HOLD_MS`). A
later event with any other status ends it at once, and a restart starts
without one (`usageLimit()` in `server/quota.ts`).

While it lasts, every POST to `/v1/chat/completions`, `/api/run`,
`/api/stream`, `/api/chat` and `/api/generate` that passes auth is answered at
once, before the inbound rate limiter, the circuit breaker and the queue
(`INFERENCE_PATHS` in `server/index.ts`). The CLI is not started, and the
answer is not a circuit-breaker failure. It is HTTP 429 with `Retry-After` set
to the seconds until the limit lifts, rounded up and at least 1, and the
message `Claude usage limit reached (<rateLimitType>); resets at <ISO-8601>.`,
with `unknown` when the event names no window. `/v1/chat/completions` carries
the message as `{"error":{"message":…,"type":"rate_limit_error","code":429}}`,
the other four paths as `{"error":…}`. `/ws` is unaffected.

`otterly.limited_until` in `GET /api/quota` is the time the limit lifts, as
ISO-8601, while it lasts, and `null` otherwise. Covered by
`tests/server/usage-limit-route.test.ts` and `tests/server/quota.test.ts`.

## Verify

Run from the Z-Book. Expected values follow `#`.

```bash
cd /home/inigo/code/iwd/otterly
grep -c 'export const DEFAULT_TIMEOUT_MS = 45 \* 60 \* 1000' src/engine.ts       # 1
grep -c 'export const DEFAULT_IDLE_TIMEOUT_MS = 5 \* 60 \* 1000' src/engine.ts   # 1
grep -c 'export const PROGRESS_INTERVAL_MS = 30 \* 1000' src/engine.ts           # 1
grep -c 'export const CLI_BACKSTOP_MS = 60 \* 1000' src/engine.ts                # 1
grep -c '"cli_progress"' src/engine.ts                                           # 1
grep -c 'cli-stdout.live.ndjson' src/engine.ts                                   # 1
grep -c 'parts.push("--effort"' src/engine.ts                                    # 1
grep -F -c 'export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];' src/engine.ts # 1
grep -F -c 'options.effort = (effort ?? "medium") as EngineOptions["effort"];' src/server/routes-openai.ts # 1
grep -F -c 'new Map<string, string>([["none", "low"], ["minimal", "low"]])' src/server/routes-openai.ts # 1
grep -F -c 'reasoning_effort?: string;' src/server/openai-compat.ts          # 1
grep -F -c 'reasoning_effort must be one of:' src/server/routes-openai.ts     # 1
grep -F -c 'reasoning-effort.test.ts' AGENTS.md                              # 2
grep -c 'idle-timeout' src/cli.ts                                                # 1 or more
grep -c 'OTTERLY_IDLE_TIMEOUT' src/cli.ts                                        # 1 or more
grep -c 'killAllChildren' src/cli.ts                                             # 1 or more
grep -F -c '(default: 2700)' src/cli.ts                                          # 2
grep -F -c '(default: 300)' src/cli.ts                                           # 1
grep -c '504: "timeout_error"' src/server/openai-compat.ts                       # 1
grep -c 'settleResponse' src/server/index.ts                                     # 1 or more
grep -c '499' src/server/index.ts                                                # 1 or more
grep -F -c 'parts.push("--include-partial-messages", "--thinking-display", "summarized");' src/engine.ts # 1
grep -F -c 'export async function* streamLines' src/engine.ts                    # 1
grep -F -c 'type: "thinking_delta"' src/events.ts                               # 1
grep -F -c 'streamLines(cmd' src/engine.ts                                       # 1
test -e src/cursor-engine.ts || test -e src/cursor-events.ts || echo absent      # absent
grep -rlE 'cursor-agent|CursorEngine|getBackend|setBackend|bwrap' src tests | wc -l # 0
grep -F -c 'OTTERLY_DISABLE_CLAUDE_CLI: "1"' vitest.config.ts                    # 1
grep -F -c 'reasoning_content: text' src/server/sse-stream.ts                    # 1
grep -F -c 'export const KEEPALIVE_MS = 5000;' src/server/sse-stream.ts          # 1
grep -F -c 'this.response.destroy();' src/server/sse-stream.ts                   # 1
grep -F -c 'export function reconcileStreamedCalls' src/server/tool-call-stream.ts # 1
grep -F -c 'export const RETRY_NOTICE_TTL_MS = 10 * 60 * 1000;' src/server/retry-notice.ts # 1
grep -F -c 'the previous attempt' src/server/retry-notice.ts                     # 1
grep -F -c '"stream_dropped_for_retry"' src/server/routes-openai.ts              # 1
grep -F -c 'err.code === "NATIVE_TOOL_CALL"' src/server/routes-openai.ts         # 1
grep -F -c 'export const DEFAULT_TRACE_RETENTION_DAYS = 7;' src/server/trace.ts   # 1
grep -F -c 'export const LOG_ROTATE_BYTES = 50 * 1024 * 1024;' src/server/trace.ts # 1
grep -F -c 'OTTERLY_TRACE_RETENTION_DAYS' src/server/trace.ts                     # 2
grep -F -c 'startTraceRetention();' src/server/index.ts                          # 1
grep -F -c 'cli-stdout.ndjson' src/engine.ts                                     # 0
grep -F -c '"sse-out.tsv"' src/server/sse-stream.ts                              # 1
grep -F -c '"dropped_for_retry"' src/server/settle.ts                            # 2
grep -F -c '"request_fingerprint"' src/server/routes-openai.ts                   # 1
grep -F -c '"cli_api_error"' src/engine.ts                                       # 1
grep -c 'anthropic-ai/claude-code' package.json                                  # 0
grep -rlE 'resolveSDK|CLAUDE_BUILTIN_TOOLS|customSystemPrompt' src tests | wc -l # 0
grep -F -c 'parts.push("--tools", tools.join(","));' src/engine.ts               # 1
grep -F -c 'parts.push("--disallowedTools", "*");' src/engine.ts                 # 1
grep -F -c 'parts.push("--permission-prompt-tool", "stdio");' src/engine.ts      # 1
grep -F -c 'export const TESTED_CLAUDE_CLI_VERSION = "2.1.296";' src/engine.ts   # 1
grep -F -c 'export function setQueryFnForTests' src/engine.ts                    # 1
grep -F -c 'await verifyClaudeCLI()' src/server/index.ts                         # 1
grep -F -c '"test:cli": "vitest run --config vitest.cli.config.ts"' package.json # 1
test -f tests-cli/claude-cli.test.ts && echo present                             # present
test -f tests/fixtures/fake-claude.mjs && echo present                           # present
grep -F -c 'req.method === "GET" && path === "/api/quota"' src/server/index.ts   # 1
grep -A4 'path === "/api/quota"' src/server/index.ts | grep -c 'checkAuth(req, ctx)' # 1
grep -F -c 'jsonResponse(res, 200, await quota.snapshot({ refresh: url.searchParams.get("refresh") === "1", cwd: ctx.workingDir }));' src/server/index.ts # 1
grep -F -c 'if (t === "rate_limit_event") quota.recordRateLimitEvent(obj.rate_limit_info);' src/engine.ts # 1
grep -rnE 'credentials\.json|\.claude\.json|api\.anthropic\.com|oauth|User-Agent' src | wc -l # 0
grep -rn 'limit-reset' src | wc -l                                               # 0
grep -cE 'readFile|fetch\(' src/server/quota.ts                                  # 0
grep -F -c 'return [cli, "-p", "/usage", "--output-format", "stream-json", "--verbose", "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"];' src/server/quota.ts # 1
grep -F -c 'return [cli, "auth", "status"];' src/server/quota.ts                 # 1
grep -F -c 'run: (argv, o) => spawnWithAbort(argv, { cwd: o.cwd, timeoutMs: o.timeoutMs }),' src/server/quota.ts # 1
grep -F -c 'const LIMIT_WINDOWS = new Map([["session", "five_hour"], ["weekly_all", "seven_day"]]);' src/server/quota.ts # 1
grep -F -c 'organization: stringField(value, "orgName"),' src/server/quota.ts    # 1
grep -F -c 'claude /usage not run: the account is at its usage limit until' src/server/quota.ts # 1
grep -F -c 'Math.round(fraction * 10_000) / 100' src/server/quota.ts             # 1
grep -F -c 'const EVENT_WINDOWS = ["five_hour", "seven_day"];' src/server/quota.ts # 1
grep -F -c 'if (!recorded || (this.live && recorded.at <= this.live.at)) continue;' src/server/quota.ts # 1
grep -F -c 'body[name] = { ...value, utilization: 0, resets_at: null };' src/server/quota.ts # 1
grep -F -c 'export const LIVE_REUSE_MS = 5 * 60 * 1000;' src/server/quota.ts      # 1
grep -F -c 'export const USAGE_MIN_INTERVAL_MS = 60 * 1000;' src/server/quota.ts  # 1
grep -F -c 'export const LIVE_FAILURE_BACKOFF_MS = 60 * 1000;' src/server/quota.ts # 1
grep -F -c 'export const USAGE_TIMEOUT_MS = 60 * 1000;' src/server/quota.ts       # 1
grep -F -c 'export const ACCOUNT_REUSE_MS = 30 * 60 * 1000;' src/server/quota.ts  # 1
grep -F -c 'export const AUTH_TIMEOUT_MS = 30 * 1000;' src/server/quota.ts        # 1
grep -F -c 'this.deps.env.CLAUDE_CONFIG_DIR || join(this.deps.homeDir(), ".claude")' src/server/quota.ts # 1
grep -cE 'writeFile|refresh_token|refreshToken' src/server/quota.ts              # 0
grep -F -c 'host:             { type: "string",  short: "H" },' src/cli.ts       # 1
grep -F -c 'host: values.host,' src/cli.ts                                       # 1
grep -F -c 'server.listen({ port, host: opts.host }' src/server/index.ts          # 1
test -f tests/server/quota.test.ts && test -f tests/server/quota-route.test.ts && test -f tests/quota-event-tap.test.ts && echo present # present
grep -F -c 'export const LIMIT_HOLD_MS = 5 * 60 * 1000;' src/server/quota.ts      # 1
grep -F -c 'private limit: { until: number; type: string } | null = null;' src/server/quota.ts # 1
grep -F -c 'if (this.eventStatus === "rejected") {' src/server/quota.ts          # 1
grep -F -c 'resetsAt * 1000 : at + LIMIT_HOLD_MS,' src/server/quota.ts           # 1
grep -F -c 'type: stringField(info, "rateLimitType") ?? "unknown",' src/server/quota.ts # 1
grep -F -c 'retryAfterS: Math.max(1, Math.ceil((this.limit.until - now) / 1000)),' src/server/quota.ts # 1
grep -F -c 'limited_until: limit ? isoFromEpoch(limit.until, 1) : null,' src/server/quota.ts # 1
grep -F -c 'const INFERENCE_PATHS = new Set(["/v1/chat/completions", "/api/run", "/api/stream", "/api/chat", "/api/generate"]);' src/server/index.ts # 1
grep -F -c 'Claude usage limit reached (${limit.type}); resets at ${new Date(limit.until).toISOString()}.' src/server/index.ts # 1
grep -F -c '"Retry-After": String(limit.retryAfterS)' src/server/index.ts         # 1
grep -F -c '? { error: { message, type: "rate_limit_error", code: 429 } }' src/server/index.ts # 1
awk '/sendAuthError\(res, format\)/{a=NR} /quota\.usageLimit\(\)/{u=NR} /rateLimiter\.allow\(/{r=NR} END{print (a && a<u && u<r) ? "after auth, before the rate limiter" : "out of order"}' src/server/index.ts # after auth, before the rate limiter
grep -c 'usageLimit' src/server/ws-handler.ts                                     # 0
test -f tests/server/usage-limit-route.test.ts && echo present                   # present
grep -c 'pnpm dlx vites[t]' AGENTS.md                                            # 0
grep -c '^pnpm exec vitest run' AGENTS.md                                        # 2
grep -F -c '"vitest": "^3.0.0"' package.json                                     # 1
```
