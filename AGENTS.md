# Otterly → Cursor Backend: Specification & Handoff Document

## 0. Document Purpose

This document specifies adding **Cursor CLI (`cursor-agent`)** support to a
already-modified fork of **Otterly** (an OpenAI-compatible HTTP shim over
agentic coding CLIs). It is written so a fresh AI/engineer can implement it
without prior conversation context. Read §1–§4 for orientation, §5 onward for
the build.

---

## 1. Birds-Eye Overview (Layman's Terms)

**What Otterly is:** a small local server that pretends to be an OpenAI API.
Clients like **AiderDesk** and **Cherry Studio** send it standard OpenAI
chat-completion requests; Otterly fulfils them by shelling out to a locally
installed, already-authenticated AI coding CLI (currently Anthropic's `claude`).
This lets you drive big models through your **flat-rate subscription** instead of
paying per-token API rates.

**What we already achieved (Claude path — DONE, working):**
- Pipe large prompts via **stdin** (avoids `E2BIG` "argument list too long").
- Strip Claude Code's auto-injected `<env>` / git-status context via the SDK's
  `customSystemPrompt` option.
- Disable Claude's built-in tools so the **client** (AiderDesk) orchestrates all
  tool use *visibly*, instead of Claude doing it invisibly server-side.
- Fix doubled responses (SDK streams incremental deltas **and** a final
  consolidated block; we suppress the duplicate).
- Function-calling bridge: parse the model's tool-call intent (incl. Claude's
  native `<function_calls>` leak format) back into OpenAI `tool_calls`.

**What we want now:** also use the **Cursor** subscription, which exposes
non-Anthropic models (gpt-5.x, gemini-2.5-pro, grok-4, plus Cursor's own
Composer) **and** Anthropic models. Goal split:
- **Anthropic models → existing Claude path** (untouched).
- **Everything else → new Cursor path** via `cursor-agent`.

**The chosen architecture:** **two separate Otterly processes on two ports**, one
per backend — *not* one server with internal routing. Routing is then done for
free by **AiderDesk**: configure two OpenAI-Compatible providers and pick the
model in the UI. This keeps the working Claude path at **zero risk** and avoids a
fragile internal refactor.

---

## 2. Why Two Instances (Not Internal Routing)

| Concern | One server, per-model routing | Two instances, two ports (CHOSEN) |
|---|---|---|
| Existing `resolveSDK()` caches one backend globally | Must rip out the singleton — touches the hot path | Each process resolves its own backend once; no change |
| Per-request engine selection | Required (fragile) | Not needed |
| Who routes Claude vs Cursor | Otterly code | **AiderDesk** (choose provider/model) |
| Risk to working Claude setup | High | **Zero** (Claude code path untouched) |
| Disable/debug one backend | Tangled | Stop one process |

Both approaches need the **same two new pieces** (a Cursor command builder + a
Cursor NDJSON parser). Two-instances avoids the routing/singleton surgery on top.

---

## 3. Key Facts Established Empirically (Ground Truth)

All from the installed `cursor-agent` (version `2026.06.15-...`) on the target
machine. **Do not re-assume these; they were observed directly.**

### 3.1 Relevant `cursor-agent` flags (from `--help`)

    -p, --print                  Headless/non-interactive. NOTE: "Has access to
                                 all tools, including write and shell."
    --output-format <format>     text | json | stream-json
    --stream-partial-output      Stream incremental text deltas (with stream-json)
    --mode <mode>                plan (read-only/planning) | ask (read-only Q&A)
    --plan                       shorthand for --mode=plan
    --model <model>              e.g. gpt-5, sonnet-4, sonnet-4-thinking
    --list-models                List available models and exit
    -f, --force / --yolo         Allow all commands (writes/shell). OMIT THIS.
    --sandbox <mode>             enabled | disabled (proven NO-OP for file reads (empirically verified); not used)
    --trust                      Trust workspace without prompting (needed in headless)
    --workspace <path>           Workspace dir (defaults to cwd)
    -H, --header <header>        Custom header (repeatable)
    --resume [chatId] / --continue   Session continuation
    --api-key <key> / CURSOR_API_KEY  (DO NOT USE — rely on `cursor-agent login`)

**Critical absences vs Claude:**
- **No `--system-prompt`** → cannot inject/replace system prompt via a flag.
  Only injection point is prepending text to the user prompt.
- **No `--tools`/`--disallowedTools`** → cannot blacklist individual tools.
  Tool restriction is coarse: mode + force-omission only.

### 3.2 Tool-control reality (researched, authoritative)

- **Reads/searches are ungoverned**: Cursor does not require approval for reading
  files or searching code, and there is **no flag to disable reads**. Total
  tool-blackout (as achieved with Claude) is **impossible** on Cursor.
- **Writes/shell are gated by omission**: in `--print` mode, `--force` is
  required to write. **Omitting `--force` + using `--mode ask`** ⇒ effectively
  read-only (no writes, no shell), but **silent reads can still happen**.
- **Do NOT rely on `permissions.deny`** denylist — deprecated (Cursor ≥1.3) and
  was bypassable.
- **Read-confinement on Cursor is enforced externally** by a mandatory bubblewrap
  jail wrapping every `cursor-agent` spawn (binds workspace + Cursor's own dirs
  only; all other paths invisible). Override for emergencies via
  `OTTERLY_NO_SANDBOX=1`.

### 3.3 Auto-loaded context

`cursor-agent` reads `AGENTS.md` and `CLAUDE.md` at project root automatically
and applies them as rules. **There is no flag to disable this.** Acceptable:
AiderDesk already passes `AGENTS.md` as context (harmless duplication).

### 3.4 Output schema (stream-json) — DIFFERS from Claude

Observed event stream (with `--stream-partial-output`):

    {"type":"system","subtype":"init","cwd":"...","session_id":"...","model":"Composer 2.5 Fast","permissionMode":"default"}
    {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"session_id":"..."}
    {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"1"}]},"session_id":"...","timestamp_ms":...}
    {"type":"assistant",...,"content":[{"type":"text","text":". Red  \n"}]},...}
    {"type":"assistant",...,"content":[{"type":"text","text":"2. Blue  \n"}]},...}
    {"type":"assistant",...,"content":[{"type":"text","text":"3. Green"}]},...}
    {"type":"assistant",...,"content":[{"type":"text","text":"1. Red  \n2. Blue  \n3. Green"}]}}   <-- final CONSOLIDATED (no timestamp_ms)
    {"type":"result","subtype":"success","duration_ms":6664,"is_error":false,"result":"1. Red  \n2. Blue  \n3. Green","session_id":"...","usage":{"inputTokens":3729,"outputTokens":46,"cacheReadTokens":7360,"cacheWriteTokens":0}}

**Crucial observations:**
1. **Incremental `assistant` deltas carry `timestamp_ms`; the final consolidated
   `assistant` block does NOT.** This is the cleanest discriminator to suppress
   the duplicate (same class of bug we fixed on the Claude path with
   `sawTextDelta`).
2. Without `--stream-partial-output`, you get only ONE `assistant` event (full
   text) + `result` (confirmed earlier in conversation).
3. Tool activity (not seen above) is reported as `tool_call` started/completed
   events. Developer reports warn Cursor's `assistant` event appears in
   **multiple undocumented shapes** — the parser must be defensive.
4. `result.result` holds the final text; `result.usage` uses
   `inputTokens`/`outputTokens` (camelCase, different from OpenAI).

---

## 4. Non-Goals / Accepted Limitations

- **No total tool blackout on Cursor.** Silent reads outside the workspace are
  prevented by the bubblewrap jail (Cursor) and by tool-blackout
  (`--tools ""` / `disallowedTools`) on Claude, including the WebSocket session
  path.
- **No system-prompt stripping flag.** Mitigated only by a prompt prefix (soft).
- **No temperature control** (same as Claude path — CLI exposes none).
- **History flattening** remains (Otterly collapses multi-turn into one prompt) —
  structural, out of scope.

### Security posture (resolved)

- **Claude** — tool-blackout (`disallowedTools: CLAUDE_BUILTIN_TOOLS`) applied on
  **both** the `/v1` OpenAI-compat routes **and** the `/ws` WebSocket session
  path. Claude has no file-read/Bash/Write tools available on either path.
- **Cursor** — always-on bubblewrap jail wraps every `cursor-agent` spawn.
  Workspace and Cursor's own state dirs are bound; all other host paths are
  absent inside the jail (reads fail with ENOENT). Network is preserved
  (`--share-net`) so the agent can reach `api2.cursor.sh`.
- **`--sandbox` flag** — proven NO-OP for file reads; not used.

---

## 5. Implementation Plan (Staged)

> Golden rule: **the existing Claude code path must remain byte-for-byte
> unchanged.** All Cursor logic is additive and gated behind a backend switch.

### Stage A — Backend switch plumbing

1. **`cli.ts`**: add `--backend <name>` option (`claude` default | `cursor`).
   Also accept `OTTERLY_BACKEND` env var. Thread the resolved value into server
   startup → engine construction.
2. Decide the wiring mechanism: simplest is a module-level/config value read by
   the engine resolver (see Stage C). Because each process is single-backend,
   a process-wide setting is acceptable (no per-request switching needed).

### Stage B — Cursor NDJSON parser (BUILD & TEST FIRST, IN ISOLATION)

Create **`src/cursor-events.ts`** exporting a normaliser that converts Cursor's
event objects into Otterly's existing `AgentEvent` union (see `types.ts`:
`TextEvent`, `TextDeltaEvent`, `ToolUseEvent`, `ToolResultEvent`, `SystemEvent`,
`ResultEvent`, `ErrorEvent`).

Mapping rules:
- `type:"system"` → `SystemEvent` (sessionId, model, cwd; tools=[]).
- `type:"user"` → ignore (it's just an echo of our own prompt).
- `type:"assistant"` **with** `timestamp_ms` → `TextDeltaEvent { delta }`
  (extract `message.content[].text`, concatenate text parts).
- `type:"assistant"` **without** `timestamp_ms` → treat as the **final
  consolidated block**: emit `TextEvent { text }` **only if no deltas were
  seen** (mirror the `sawTextDelta` suppression). If deltas were streamed,
  **skip** it to avoid duplication.
- `type:"tool_call"` (started) → `ToolUseEvent`; (completed) → `ToolResultEvent`.
  Field names TBD — capture a real sample (see Open Questions) before finalising.
- `type:"result"` → `ResultEvent { text: result, cost: 0, duration: duration_ms,
  sessionId, usage: { input_tokens: usage.inputTokens, output_tokens:
  usage.outputTokens } }`. (Cursor gives no cost; set 0.)
- Unknown/garbled `assistant` shapes → defensive: try `message.content` array,
  then `message.text`, then `text`; if all fail, skip the event (never throw).

Unit-test this parser against the exact NDJSON in §3.4 before wiring anything.

### Stage C — Cursor engine / command builder

Create **`src/cursor-engine.ts`** mirroring `ClaudeEngine`'s **public shape**
(`run()`, `stream()`, `session()` — at minimum `run()` and `stream()`), so the
HTTP routes can use either engine interchangeably.

Reuse the **existing `spawnWithAbort`** from `engine.ts` (export it if not
already) — it already does stdin-piping (E2BIG-safe), the SIGTERM→SIGKILL kill
ladder, and abort handling. Do **not** reinvent it.

Command to build (array form; prompt via **stdin**, not argv):

    cursor-agent -p \
      --output-format stream-json \
      --stream-partial-output \
      --mode ask \
      --trust \
      --workspace <cwd> \
      --model <model>
    # DELIBERATELY OMIT --force/--yolo  (enforces no writes/shell)
    # Consider: --sandbox enabled  (pending Open Question Q1)

Prompt assembly (the only system-prompt substitute available):
- Prepend a **read-only reasoning directive** to the user prompt, e.g.:

      You must NOT read, search, open, or edit any files, and must NOT run
      shell commands. Reason ONLY over the information provided in this
      message and return your answer directly.

  Then a separator, then Otterly's existing flattened prompt. (Soft guard;
  combine with `--mode ask` for the hard guard.)

Engine flow: spawn → feed prompt to stdin → read stdout → split NDJSON by line →
`JSON.parse` each → pass through `cursor-events.ts` normaliser → yield
`AgentEvent`s. `stream()` yields incrementally; `run()` aggregates to
`AgentResult` (reuse the same accumulation logic shape as `ClaudeEngine.run`).

### Stage D — Engine selection in HTTP routes

In `routes-openai.ts`, where `new ClaudeEngine()` is instantiated
(`handleNonStreaming`, `handleStreaming`, `handleFunctionCalling`), select the
engine by the process backend (Stage A). Keep it trivial:

    const engine = BACKEND === "cursor" ? new CursorEngine() : new ClaudeEngine();

**Tool handling divergence (IMPORTANT):**
- On the Cursor path, the Claude-specific `disallowedTools =
  CLAUDE_BUILTIN_TOOLS` is **meaningless** (different tool system). Leave it set
  (harmless/ignored) OR guard it out for cursor. Functional control on Cursor is
  via `--mode ask` + no `--force` (Stage C), not via this option.
- The function-calling bridge (`buildToolInstruction` / `parseToolCalls`) is
  backend-agnostic (it works on text), so it can remain in play for Cursor too.
  Verify Cursor respects the JSON tool-call instruction in testing.

### Stage E — Models catalog

In **`models.ts`**, serve a backend-appropriate list. Two clean options:
- **Static seed** for cursor (from `cursor-agent --list-models`), OR
- shell `cursor-agent --list-models` at startup and cache.

Static seed is simpler and matches Otterly's existing philosophy. Provide a
separate exported list (e.g. `CURSOR_MODELS`) and have `buildModelsList()` /
discovery endpoints serve the set matching the active backend.

**Also refresh the Claude list** (the catalog is stale) to the current API IDs:

    claude-opus-4-8
    claude-sonnet-4-6
    claude-haiku-4-5-20251001

(Verify each is accepted by the installed `claude` before shipping:
`claude --model <id> -p "hi"`.)

For Cursor, seed from `cursor-agent --list-models` output (examples cited
historically: `composer-2.5`, `claude-sonnet-4-6`, `claude-opus-4-7`, `gpt-5.5`,
`gemini-2.5-pro`, `grok-4`) — but **capture the real list on the target machine**
rather than trusting these names.

### Stage F — Run two instances

    # Claude (existing)
    otterly serve -p 11435 -d /path/to/project          # backend defaults to claude

    # Cursor (new)
    otterly serve --backend cursor -p 11436 -d /path/to/project

AiderDesk: two OpenAI-Compatible providers —
- `http://localhost:11435/v1` → Claude models
- `http://localhost:11436/v1` → Cursor models

---

## 6. Files Touched (Summary)

| File | Change | Risk |
|---|---|---|
| `src/cli.ts` | Add `--backend` flag + `OTTERLY_BACKEND` | Low |
| `src/cursor-events.ts` | **NEW** — Cursor NDJSON → `AgentEvent` | Isolated |
| `src/cursor-engine.ts` | **NEW** — Cursor command builder + stream | Isolated |
| `src/engine.ts` | Export `spawnWithAbort` (if not already) for reuse | Low |
| `src/server/routes-openai.ts` | Engine selection by backend | Medium (shared file — be surgical) |
| `src/server/models.ts` | Backend-aware catalog; refresh IDs | Low |

**Untouched (Claude correctness-critical):** `engine.ts` Claude logic,
`events.ts`, `openai-compat.ts` parsing/bridge, `permissions.ts`, `session.ts`.

---

## 7. Testing Plan

1. **Parser unit test** (Stage B) against §3.4 NDJSON → expect one coalesced
   answer, no duplication, correct usage mapping.
2. **Cursor engine direct** (bypass HTTP):
   - `run()` a simple prompt; assert single clean text + `result`.
   - `stream()` the same; assert deltas arrive then are NOT followed by a
     duplicated consolidated block.
3. **Via Otterly HTTP** (curl to `:11436/v1/chat/completions`), streaming and
   non-streaming.
4. **Via AiderDesk** (provider on `:11436`):
   - Ask/plan task: confirm reasoning works, response appears once.
   - Confirm **no writes** occur (read-only): attempt an edit-style request and
     verify nothing is modified on disk.
   - Agent mode: confirm tool calls (if used) surface in AiderDesk, not silently.
5. **Read-confinement probe** (Open Question Q1): ask the Cursor model to read an
   absolute path outside the workspace; observe whether it can. Run with and
   without `--sandbox enabled`.
6. **Regression:** confirm the Claude instance on `:11435` is byte-for-byte
   unaffected (same prompts, same outputs as before).

---

## 8. Open Questions (Resolve During Build)

- **Q1 (security) — RESOLVED:** `--workspace` does NOT confine reads; the agent
  can read absolute paths outside it. `--sandbox enabled` is a proven NO-OP for
  file reads (empirically verified). The mechanism is bubblewrap: every
  `cursor-agent` spawn is wrapped in a `bwrap` jail that binds only the workspace
  and Cursor's own state dirs — all other paths are invisible. Claude needs no
  jail because its tools are disabled via `disallowedTools`.
- **Q2 (tool events):** Capture a real `tool_call` started/completed event pair
  from `cursor-agent` (trigger a tool in a non-read-only run) to finalise the
  `ToolUseEvent`/`ToolResultEvent` field mapping in `cursor-events.ts`.
- **Q3 (model list):** Capture actual `cursor-agent --list-models` output on the
  target machine; seed `CURSOR_MODELS` from it.
- **Q4 (function-calling):** Does Cursor reliably emit the requested tool-call
  JSON (for the `parseToolCalls` bridge), or does it ignore the instruction in
  `--mode ask`? Determines whether agent-mode tool use works on the Cursor path.
- **Q5 (assistant shapes):** Collect any divergent `assistant` event shapes
  (developer reports mention several) and harden the parser accordingly.

---

## 9. Current State Recap (Claude Path — Reference)

Already-applied modifications to the fork (working):
- `engine.ts`: stdin prompt piping via `spawnWithAbort` (E2BIG fix);
  `customSystemPrompt` (env/git strip); `if (opts.effort) queryOptions.effort`
  (effort delivery — efficacy unconfirmed on current models).
- `routes-openai.ts`: `maxTurns: 1` backstop; `disallowedTools =
  CLAUDE_BUILTIN_TOOLS` on both tool/no-tool paths; `sawTextDelta` duplicate
  suppression in `handleStreaming`; effort-by-model block (optional).
- `openai-compat.ts`: softened `buildToolInstruction` (no "router lobotomy");
  `parseToolCalls` accepts JSON object, bare array, `{name,arguments}`, Claude's
  `<function_calls>` blocks, and embedded fragments; extended
  `CLAUDE_BUILTIN_TOOLS` (added `SlashCommand`, `Skill`, `LS`, `NotebookRead`).
- `types.ts`: `effort?: "low"|"medium"|"high"|"xhigh"|"max"`.

These are candidate upstream PRs (mostly universal bugfixes; the tool-disabling
and `maxTurns` are behaviour changes needing a changelog note).

---

## 10. Definition of Done

- `otterly serve --backend cursor -p 11436` serves Cursor models over an
  OpenAI-compatible endpoint.
- AiderDesk (provider on `:11436`) gets clean, single (non-duplicated) responses
  from at least one non-Anthropic Cursor model (e.g. gpt-5.x / gemini / grok).
- Read-only posture verified: no writes/shell from the Cursor path.
- Claude instance on `:11435` regression-free.
- Open Questions Q1–Q5 answered and reflected in code/comments.
