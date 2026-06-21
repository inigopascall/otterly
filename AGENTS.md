# Otterly: Dual-Backend Architecture (Claude + Cursor)

## 0. Document Purpose

This document orients an AI/engineer working on this fork of **Otterly** — an
OpenAI-compatible HTTP shim over agentic coding CLIs. It describes the
two-backend architecture (Claude + Cursor), the security model, and the
per-backend behaviour each engine implements. Read §1–§4 for orientation, §5
onward for file-level detail.

---

## 1. Birds-Eye Overview

**What Otterly is:** a local server that speaks the OpenAI API. Clients like
**AiderDesk** and **Cherry Studio** send standard OpenAI chat-completion
requests; Otterly fulfils them by shelling out to a locally installed,
already-authenticated AI coding CLI. This drives big models through a
**flat-rate subscription** instead of per-token API rates.

**Two backends, selected per process:**
- **Claude** (`@anthropic-ai/claude-code` SDK, with the `claude` CLI as a
  fallback) — Anthropic models.
- **Cursor** (`cursor-agent` CLI) — non-Anthropic models (gpt-5.x, gemini, grok,
  kimi) plus Cursor's own Composer **and** Anthropic models served via Cursor.

**Architecture:** **one Otterly process per backend, on its own port.** A client
configures two OpenAI-Compatible providers and selects the model in its UI, so
routing happens client-side. Each process resolves its backend once at startup
(`setBackend()` in `models.ts`).

**Behaviour shared by both backends:**
- Large prompts are piped via **stdin** (avoids `E2BIG` "argument list too long").
- Streaming emits incremental text deltas; the final consolidated block is
  suppressed once deltas have been sent (`sawTextDelta`).
- A function-calling bridge converts the model's tool-call intent into OpenAI
  `tool_calls`, so clients drive tool execution.

**Claude-specific behaviour:**
- The SDK's `customSystemPrompt` replaces Claude Code's auto-injected `<env>` /
  git-status context with a neutral prompt.
- `disallowedTools: CLAUDE_BUILTIN_TOOLS` removes Claude's built-in file/shell
  tools, so the client orchestrates all tool use visibly.

**Cursor-specific behaviour:**
- Every `cursor-agent` spawn runs inside a **bubblewrap jail** that confines
  filesystem reads to the workspace and Cursor's own state dirs.
- A read-only prompt directive is prepended; when the request carries client
  tools, the directive switches to one that permits emitting `tool_calls` JSON.

---

## 2. Why One Process Per Backend

| Concern | One server, per-model routing | One process per backend (CHOSEN) |
|---|---|---|
| `resolveSDK()` caches one backend globally | Requires removing the singleton — touches the hot path | Each process resolves its own backend once |
| Per-request engine selection | Required | Not needed |
| Who routes Claude vs Cursor | Otterly code | The client (choose provider/model) |
| Isolating the Claude path | Coupled | Fully separate process |
| Disable/debug one backend | Tangled | Stop one process |

Both backends share the two core pieces (a command builder + an NDJSON parser).
The per-process model keeps each backend's resolution independent.

---

## 3. Cursor CLI Ground Truth

All observed directly from the installed `cursor-agent` on the target machine.

### 3.1 Relevant `cursor-agent` flags (from `--help`)

    -p, --print                  Headless/non-interactive.
    --output-format <format>     text | json | stream-json
    --stream-partial-output      Stream incremental text deltas (with stream-json)
    --mode <mode>                plan (read-only/planning) | ask (read-only Q&A)
    --model <model>              e.g. gpt-5.5-high, composer-2.5, claude-opus-4-8-max
    --list-models                List available models and exit
    --trust                      Trust workspace without prompting (needed in headless)
    --workspace <path>           Workspace dir (defaults to cwd)
    --resume [chatId] / --continue   Session continuation

Otterly invokes `cursor-agent` with `--mode ask` and omits `--force`/`--yolo`, so
the agent performs no writes or shell commands. Authentication comes from
`cursor-agent login`; the CLI's `--api-key` flag is unused.

**Differences from the Claude CLI:**
- No `--system-prompt` flag. The system prompt is injected by prepending text to
  the user prompt (see `buildCursorPrompt` in `cursor-engine.ts`).
- No per-tool allow/deny flags. Write/shell prevention is by `--mode ask` + no
  `--force`; read confinement is by the bubblewrap jail (§3.2).

### 3.2 Read confinement (bubblewrap)

`cursor-agent` reads files and searches code without approval and exposes no flag
to disable reads. Read confinement is enforced **externally**: a mandatory
bubblewrap (`bwrap`) jail wraps every `cursor-agent` spawn
(`buildBwrapPrefix` in `cursor-engine.ts`).

The jail binds:
- The workspace directory read-write (the one writable real path).
- Cursor's own state dirs (`~/.cursor`, `~/.config/cursor`) read-write, for token
  refresh and session state.
- The `cursor-agent` binary and bundled runtime under `~/.local` read-only.
- System runtime (`/usr`, `/lib`, `/bin`, `/etc` essentials) read-only.
- Network (`--share-net`) so the agent reaches `api2.cursor.sh`.

Everything else is absent inside the jail; reads of arbitrary host paths fail
with ENOENT. The compile cache is redirected to a tmpfs via `XDG_CACHE_HOME` and
`NODE_COMPILE_CACHE`. `bwrap` is required; setting `OTTERLY_NO_SANDBOX=1` runs
`cursor-agent` unconfined (emergency escape hatch).

`findCursorCLI()` resolves `cursor-agent` to its real symlink target with
`realpathSync`. The launcher is a bash script that locates its bundled `node` and
`index.js` via `realpath "$0"`; invoking the resolved path under
`~/.local/share/cursor-agent/versions/<v>/` (which the jail binds) keeps that
self-location working inside the sandbox.

### 3.3 Auto-loaded context

`cursor-agent` reads `AGENTS.md` and `CLAUDE.md` at the workspace root and applies
them as rules. Otterly's default working directory is a clean scratch dir
(`SCRATCH_DIR`), which keeps this context empty unless a project dir is passed
with `-d`.

### 3.4 Output schema (stream-json)

Event stream with `--stream-partial-output`:

    {"type":"system","subtype":"init","cwd":"...","session_id":"...","model":"Composer 2.5 Fast","permissionMode":"default"}
    {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"session_id":"..."}
    {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"1"}]},"session_id":"...","timestamp_ms":...}
    {"type":"assistant",...,"content":[{"type":"text","text":". Red  \n"}]},...}
    {"type":"assistant",...,"content":[{"type":"text","text":"2. Blue  \n"}]},...}
    {"type":"assistant",...,"content":[{"type":"text","text":"3. Green"}]},...}
    {"type":"assistant",...,"content":[{"type":"text","text":"1. Red  \n2. Blue  \n3. Green"}]}}   <-- final CONSOLIDATED (no timestamp_ms)
    {"type":"result","subtype":"success","duration_ms":6664,"is_error":false,"result":"1. Red  \n2. Blue  \n3. Green","session_id":"...","usage":{"inputTokens":3729,"outputTokens":46,"cacheReadTokens":7360,"cacheWriteTokens":0}}

**Parser behaviour (`cursor-events.ts`):**
1. Incremental `assistant` deltas carry `timestamp_ms`; the final consolidated
   `assistant` block does not. The parser yields `text_delta` for deltas and
   suppresses the consolidated block once any delta has been seen (`sawTextDelta`).
2. Without `--stream-partial-output`, a single `assistant` event (full text)
   precedes `result`; with no deltas seen, the parser emits it as a `text` event.
3. Tool activity arrives as `tool_call` events. The parser maps started calls to
   `tool_use` and completed calls to `tool_result`, trying several field aliases.
4. `result.result` holds the final text; `result.usage` uses
   `inputTokens`/`outputTokens` (camelCase), mapped to `input_tokens`/`output_tokens`.

The parser is defensive: it extracts text from `message.content[]`,
`message.content` (string), or `message.text`, and returns `[]` for unknown or
malformed events rather than throwing.

---

## 4. Security Posture

- **Claude** — `disallowedTools: CLAUDE_BUILTIN_TOOLS` is set on **both** the
  `/v1` OpenAI-compat routes (`routes-openai.ts`) **and** the `/ws` WebSocket
  session path (`ws-handler.ts`). Claude has no file-read/Bash/Write tools on
  either path, so it cannot read or modify the filesystem.
- **Cursor** — the always-on bubblewrap jail (§3.2) confines reads to the
  workspace and Cursor's own dirs. `--mode ask` + no `--force` prevents writes and
  shell commands. Network is preserved for API access.
- **`--sandbox` flag** — proven NO-OP for file reads; not used.

### Accepted limitations

- **No temperature control** — neither CLI exposes a sampling-temperature flag.
  For Cursor, reasoning tier is selected via the model ID suffix (e.g. `-high`,
  `-max`); see §6.
- **History flattening** — Otterly collapses multi-turn history into a single
  prompt (structural to the shim design).

---

## 5. Backend Plumbing

The active backend is process-wide state in `models.ts` (`setBackend()` /
`getBackend()`), set once at startup from `startApiServer({ backend })`.

- **`cli.ts`** parses `--backend <claude|cursor>` (and `OTTERLY_BACKEND`),
  validates it, and passes it into `startApiServer`.
- **`server/index.ts`** calls `setBackend(backend)` during startup.
- **`server/engine-factory.ts`** `makeEngine()` returns a `CursorEngine` or
  `ClaudeEngine` based on `getBackend()`. All HTTP routes obtain their engine
  through `makeEngine()`, so engine selection is centralised.

`getModels()`, `getDefaultModel()`, and `findModel()` in `models.ts` return the
catalog for the active backend, so discovery endpoints (`/v1/models`,
`/api/tags`, `/api/show`) serve the correct list automatically.

---

## 6. Cursor Engine Detail (`cursor-engine.ts`)

`CursorEngine` mirrors `ClaudeEngine`'s `run()`/`stream()` interface. It builds an
argv array (no shell), feeds the prompt via stdin, spawns through the shared
`spawnWithAbort` from `engine.ts`, splits the NDJSON output by line, and passes
each parsed object through `normalizeCursorEvent`.

**Command (`buildCursorCommand`):**

    cursor-agent -p \
      --output-format stream-json \
      --stream-partial-output \
      --mode ask \
      --trust \
      --workspace <cwd> \
      --model <model>

**Prompt assembly (`buildCursorPrompt`)** prepends one of two directives, then
the system prompt (if any), then the user request:
- **Default:** reason over the message and answer directly.
- **`clientToolCalls`:** permit emitting a `tool_calls` JSON object for an
  external client. `routes-openai.ts` sets `clientToolCalls` on `EngineOptions`
  whenever the request carries OpenAI `tools`.

**Model IDs and reasoning tier:** the request's `model` is passed straight to
`--model`. Cursor encodes reasoning tier in the ID suffix (e.g. `gpt-5.5-high`,
`claude-opus-4-8-max`, `composer-2.5-fast`). `CURSOR_MODELS` in `models.ts` seeds
a representative subset for discovery; any valid CLI ID also works when sent
directly, since the request path does not validate against the catalog.

---

## 7. Files (Map)

| File | Role |
|---|---|
| `src/cli.ts` | `--backend` flag + `OTTERLY_BACKEND`; starts the server |
| `src/cursor-events.ts` | Cursor NDJSON → `AgentEvent` parser |
| `src/cursor-engine.ts` | Cursor command builder, bubblewrap jail, stream/run |
| `src/engine.ts` | Claude engine + shared `spawnWithAbort` |
| `src/session.ts` | Claude multi-turn SDK session (used by `/ws`) |
| `src/server/engine-factory.ts` | `makeEngine()` — backend-aware engine selection |
| `src/server/routes-openai.ts` | `/v1/chat/completions`; sets `clientToolCalls` |
| `src/server/ws-handler.ts` | `/ws` sessions; sets `disallowedTools` |
| `src/server/models.ts` | Backend-aware model catalogs + backend state |
| `src/server/openai-compat.ts` | OpenAI translation, `CLAUDE_BUILTIN_TOOLS`, tool bridge |

---

## 8. Running Both Backends

    # Claude
    otterly serve -p 11435 -d /path/to/project          # backend defaults to claude

    # Cursor
    otterly serve --backend cursor -p 11436 -d /path/to/project

In a client (e.g. AiderDesk), add two OpenAI-Compatible providers with distinct
provider IDs:
- `http://localhost:11435/v1` → Claude models
- `http://localhost:11436/v1` → Cursor models

The Cursor backend requires `bwrap` installed (`sudo apt install bubblewrap`).

---

## 9. Scope Notes

- **Cursor in `--mode ask`** is a read-only reasoning posture: it answers and
  reasons but does not autonomously edit files. The function-calling bridge still
  lets it emit OpenAI `tool_calls` for a client to execute.
- **Cursor `session()`** is not implemented; the `Session` multi-turn path is
  Claude-SDK-specific and serves the `/ws` endpoint. One-shot routes
  (`/v1/chat/completions`, `/api/run`, `/api/stream`, Ollama routes) use
  `run()`/`stream()` and apply to both backends.
- **The Claude CLI fallback** (`createCLIQueryFn` in `engine.ts`) is used only
  when the SDK package is absent; the SDK path is preferred.
