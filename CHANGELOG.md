# Changelog

All notable changes to this project are documented in this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and uses [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting.

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
