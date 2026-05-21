# Changelog

All notable changes to this project are documented in this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and uses [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting.

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
