# Changelog

All notable changes to this project are documented in this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and uses [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting.

## [0.8.0] - 2026-06-03

### Added

- **Ollama-native API.** otterly now speaks Ollama's own protocol on port
  `11434`, not just OpenAI compat — so Ollama-only tools (Open WebUI's native
  connection, Raycast, oterm, homelab dashboards) auto-discover it with zero
  config and list your Claude models in their picker.
  - `GET /api/tags` — model discovery (tools poll this on startup).
  - `POST /api/chat` — conversational chat, NDJSON stream (`stream` defaults to
    `true`, matching Ollama).
  - `POST /api/generate` — single-prompt completion, NDJSON stream.
  - `POST /api/show` — model metadata (context length, capabilities).
  - `GET /api/version`, `GET /api/ps`, and a `POST /api/pull` success stub.
- **`GET /v1/models`** — OpenAI-format model list. Many OpenAI clients probe
  this on startup; otterly now answers instead of returning 404.
- **Real OpenAI function calling.** Supplying OpenAI `tools` now returns proper
  `tool_calls` with `finish_reason: "tool_calls"` (non-streaming and streaming),
  so agentic clients (Cline, Aider, your own scripts) get the structured calls
  they expect. Supports `tool_choice` `none` / `required` / `{function}`,
  multi-turn `tool` + assistant-`tool_calls` history, and multiple parallel
  calls. The parser tolerates code fences and surrounding prose/thinking text.
- Shared model catalog (`models.ts`) backing both `/v1/models` and `/api/tags`.
- OpenAPI spec and README updated to document all new endpoints.

### Changed

- When a request carries OpenAI `tools`, otterly now disables Claude's own
  built-in tools (`disallowedTools`) for that request, following OpenAI
  semantics that the **caller** executes the functions. Previously the tool
  names were mapped onto Claude's built-ins, which could let Claude run
  `Bash`/`Write`/`Edit` on the server host. The new behavior is both correct and
  safer.

## [0.7.0] - 2026-05-23

### Added

- **Dashboard** at `GET /dashboard` — live spend (today + lifetime), tokens
  in/out, average latency, error count, recent runs table, top tools by
  cumulative usage, and queue/circuit-breaker status. Auto-refreshes every
  3 seconds. Backed by `GET /api/metrics`.
- **`GET /api/metrics`** — JSON snapshot of in-memory rolling metrics
  (`totals`, `today`, `topTools`, `recent`, `startedAt`).
- **Light mode** for the playground and dashboard, with a header toggle
  persisted to `localStorage` and an initial value derived from
  `prefers-color-scheme`. Override per request with `?theme=light|dark`.
- **Host integration recipes** in the README for Cline, Cursor, Continue,
  and Aider — anyone arriving from those communities now sees themselves
  in the docs.
- README screenshots of the dashboard and playground (dark + light).

### Changed

- **Playground UI redesign**: sidebar nav (Dashboard / Playground / Reference),
  per-pane segmented Formatted/Raw response toggle, JSON renderer with line
  numbers and indent guides, copy button on response bodies, inline JSON
  validation on the editor (red border + inline message when invalid),
  `Cmd/Ctrl-Enter` to send, header status pill showing live queue stats,
  proper SVG brand mark (replacing the emoji), and a Google Fonts stack
  (Inter + JetBrains Mono).

### Fixed

- Status panel was reading `queue.active` from `/api/status`, but the queue
  stats key is `queue.running`. The old "Active" metric therefore always
  displayed `0`. Fixed in the new dashboard.
- `PKG_VERSION` was hardcoded to `0.3.6` (and `0.6.0` in one place). It
  now reads from `package.json` at startup and is threaded through
  `/api/status`, `/api/metrics`, and the playground/dashboard header.

## [0.6.0] - 2026-05-22

### Documentation

- New **"Best configuration for OpenClaw"** subsection in the README with the
  specific tuning advice we wish every OpenClaw user knew before plugging
  otterly in: `--max-concurrent` sizing per machine class, `--queue-timeout`
  guidance for slow first spawns, a copy-paste systemd unit, and a sanity
  check command (`openclaw capability model run`) to validate the provider
  before flipping the default model.
- Documented the failure mode to recognize: *"Agent couldn't generate a
  response"* on a turn that should obviously work means otterly is below
  0.5.0 (streaming response was dropped).
- Documented `--queue-timeout` flag and `queueTimeoutMs` programmatic option
  in the server config table.
- README pass: removed em-dash overuse so the prose reads less like it was
  generated and more like it was written.

## [0.5.0] - 2026-05-22

### Fixed

- **Streaming chat completions returned empty content when otterly was driving
  the `claude` CLI binary** (the common install — the SDK is an optional peer
  dep). The CLI's stream-json output emits a single `text` event with the full
  answer, while otterly's streaming handler only watched for `text_delta`
  events. Result: clients with `stream: true` (OpenAI/JS SDK, LangChain,
  LiteLLM, OpenWebUI, OpenClaw, etc.) got `role` chunk → `[DONE]` with no
  content. Now both `text` and `text_delta` events produce content chunks.
- **SSE streams could appear stalled during Claude Code cold spawn or
  large-prompt processing.** Otterly sent the initial role chunk then went
  silent until the first delta arrived; clients with idle-detection abandoned.
  Added 5-second SSE keepalive heartbeats (`: keepalive\n\n` comment lines,
  spec-compliant and ignored by all OpenAI-compatible parsers) until the first
  content event.
- **Duplicate content** when an event sequence emitted both a `text` event and
  a `result` event with the same text. The `result` event no longer emits text
  content — only the terminal `stop` chunk.

### Changed

- `queueTimeoutMs` default raised from **30s** to **120s**. On slow hardware
  (Raspberry Pi, low-end VPS) or with large system prompts, Claude Code cold
  spawn alone can take ~30s; the old default caused cascading 408 timeouts
  under any concurrent load.

### Added

- `--queue-timeout <seconds>` CLI flag.
- `queueTimeoutMs` programmatic option on `startApiServer()`.

### Known issue (not fixed in this release)

- Worker slots can leak when a Claude Code subprocess hangs past the per-request
  timeout. The CLI path uses `execSync`, which can't be cancelled mid-flight —
  the AbortController fires but the queue slot stays occupied until the spawn
  returns naturally. Workaround: lower `--max-concurrent`, raise
  `--queue-timeout`. Proper fix planned for a future release (switch to
  `child_process.spawn` with signal propagation).

## [0.4.1] - 2026-05-21

### Documentation

- Repositioned the README around the OpenClaw recipe — the killer use case
  after Anthropic's April 4, 2026 policy change that cut OpenClaw off from
  Claude Code subscriptions.
- Added a "Get your subscription back." section with a full JSON5 patch for
  OpenClaw's `models.providers` config.
- Clarified that otterly is a transport layer, not a security or filtering
  layer. It routes requests through the local `claude` CLI; it does not
  inspect, modify, or block prompts.
- Added headless / Raspberry Pi guidance for the one-time `claude` browser
  login on remote machines.

## [0.4.0] - 2026-05-20

### Changed

- Repositioned the package as "Ollama for Claude". The previous framing of
  "use Claude Code as a library" was technically correct but undersold the
  value: the package is a local OpenAI-compatible API on `localhost:11434`
  powered by your existing Claude Code subscription.
- README rewritten to lead with the three integration shapes: library,
  CLI server (`npx otterly serve`), and embedded programmatic server
  (`startApiServer`).

## [0.3.7] - 2026-05-18

### Fixed

- Various small polish items in the embedded server and CLI version output.

## [0.3.x] series - 2026-05-16

Initial public releases (`0.3.0` through `0.3.6`). Established the package
shape: `ClaudeEngine`, `Session`, the OpenAI-compatible server, and the WS
session handler. Examples folder seeded with 13 numbered scripts.

## [0.1.0] - 2026-05-16

First version published to npm.
