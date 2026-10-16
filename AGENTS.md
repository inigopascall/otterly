---
verified: 2026-10-15
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

**Transport:** the on-PATH `claude` CLI, with the `@anthropic-ai/claude-code`
npm SDK as a fallback when no CLI is found (§5).

**Behaviour:**
- Large prompts are piped via **stdin** (avoids `E2BIG` "argument list too long").
- Streaming emits incremental text deltas; the final consolidated block is
  suppressed once deltas have been sent.
- A function-calling bridge converts the model's tool-call intent into OpenAI
  `tool_calls`, so clients drive tool execution.
- The CLI path uses safe-mode, empty built-in tools, strict empty MCP configuration,
  and forwards `maxTurns`; the SDK fallback is not described as verified isolation.
- The CLI runs with `--include-partial-messages --thinking-display summarized`, so
  the model's summarised thinking and its reply arrive as `stream_event` lines
  while they are generated. Streamed responses relay them as `reasoning_content`
  and `content` chunks (§11).
- When `clientToolCalls` is enabled, unexpected native tool inventory or activity
  is rejected; a native `tool_use` block is rejected as soon as it starts. A
  non-streamed request gets HTTP 502; a streamed one has its connection dropped
  so the client retries (§11).

---

## 2. Security Posture

- **Native tools** — the CLI path applies safe-mode, empty built-ins, and a strict
  empty MCP config. With `clientToolCalls`, unexpected native inventory/activity is
  rejected as soon as it appears: HTTP 502 for a non-streamed request, a dropped
  connection for a streamed one. This is not a pre-execution sandbox claim.
  `maxTurns` is forwarded to the CLI.
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
| `src/engine.ts` | Claude engine, CLI command builder, `spawnWithAbort` and `streamLines` |
| `src/events.ts` | Claude NDJSON → `AgentEvent` parser (`text_delta`, `thinking_delta`) |
| `src/session.ts` | Claude multi-turn SDK session (used by `/ws`) |
| `src/server/engine-factory.ts` | `makeEngine()` — the engine every HTTP route uses; tests replace it |
| `src/server/routes-openai.ts` | `/v1/chat/completions`; sets `clientToolCalls` |
| `src/server/ws-handler.ts` | `/ws` sessions; sets `disallowedTools` |
| `src/server/models.ts` | Model catalog |
| `src/server/openai-compat.ts` | OpenAI translation, `CLAUDE_BUILTIN_TOOLS`, tool bridge |
| `src/server/sse-stream.ts` | `SseStream`: the SSE chunks of one streamed completion |
| `src/server/tool-call-stream.ts` | `ToolCallStreamer, reconcileStreamedCalls`: live tool calls |
| `src/server/retry-notice.ts` | Remembers dropped requests; notice on the retry |

---

## 4. Running

    otterly serve -p 11435 -d /path/to/project

With no `-d`, the server uses an empty scratch directory under the system temp
folder (`SCRATCH_DIR`). In a client (e.g. AiderDesk), add an OpenAI-Compatible
provider with base URL `http://localhost:11435/v1`.

---

## 5. Scope Notes

- **`Session`** is the multi-turn path and serves the `/ws` endpoint. One-shot
  routes (`/v1/chat/completions`, `/api/run`, `/api/stream`, Ollama routes) use
  `run()`/`stream()`.
- **Transport selection** (`resolveSDK` in `engine.ts`): the on-PATH `claude`
  CLI is tried **first**, and the npm SDK is used only when no CLI is found.
  Both paths produce `stream_event` messages, so both emit `text_delta` and
  `thinking_delta` events.

## 6. Building and re-deploying the global install

```
cd /home/inigo/code/otterly
pnpm run build
pnpm i -g .
```

## 7. Running tests

Run Vitest through pnpm dlx, which downloads a temporary executable and runs it without changing the repo:

```
pnpm dlx vitest run
```

`vitest.config.ts` sets `OTTERLY_DISABLE_CLAUDE_CLI=1`, which makes
`findClaudeCLI()` return null, so tests use the mocked npm SDK and never spawn
a real `claude`.

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
| `command.txt` | The exact `claude` command line |
| `prompt.txt` | The exact bytes written to the CLI's stdin |
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

- **No output for 2 minutes** (the idle limit). The CLI prints the model's
  thinking and its reply as they are generated, so silence means the run
  has stopped making progress.
- **20 minutes in total** (the hard cap), however much output there is.

Override either, in seconds:

    otterly serve --idle-timeout 180 --request-timeout 1800 --stream-timeout 1800
    OTTERLY_IDLE_TIMEOUT=180 OTTERLY_REQUEST_TIMEOUT=1800 OTTERLY_STREAM_TIMEOUT=1800 otterly serve

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

Non-streamed tool requests are buffered, and fail with HTTP 502 as in §4.

## Verify

Run from the Z-Book. Expected values follow `#`.

```bash
cd /home/inigo/code/iwd/otterly
grep -c 'export const DEFAULT_TIMEOUT_MS = 20 \* 60 \* 1000' src/engine.ts       # 1
grep -c 'export const DEFAULT_IDLE_TIMEOUT_MS = 2 \* 60 \* 1000' src/engine.ts   # 1
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
```
