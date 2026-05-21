<p align="center">
  <h1 align="center">otterly</h1>
  <p align="center"><strong>Ollama for Claude.</strong> Use your Claude Code subscription as a local AI API — for free.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/otterly"><img src="https://img.shields.io/npm/v/otterly.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/otterly"><img src="https://img.shields.io/npm/dm/otterly.svg" alt="npm downloads"></a>
  <a href="https://github.com/josharsh/otterly/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/otterly.svg" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/otterly.svg" alt="node version"></a>
</p>

---

## The pitch in one breath

You already pay **\$20–\$200/month** for Claude Code. Then you build a side project, a script, a tiny agent — and Anthropic charges you **again** per token via the API. That's double-paying for the same brain.

**Otterly fixes that.** It turns your existing Claude Code subscription into a local, OpenAI-compatible API — exactly like Ollama does for open-source models — but powered by the Claude that you're already paying for.

```bash
npx otterly serve
```

```
  otterly — local inference server
  ──────────────────────────────────────
  OpenAI compat : http://localhost:11434/v1/chat/completions
  Playground    : http://localhost:11434/playground
  Ready. Point any OpenAI client at it.
```

Same port as Ollama. Same OpenAI-compatible API. Zero per-token cost. No API keys.

---

## Three ways to use it

| | **Library** | **CLI server** | **Embedded server** |
|---|---|---|---|
| How | `import { claude } from "otterly"` | `npx otterly serve` | `await startApiServer({ port })` |
| Best for | Node.js scripts & agents | Any language, any tool | Bundling the server into your app |
| Network | None — in-process | localhost HTTP/WS | localhost HTTP/WS |
| Analogy | Direct function call | `ollama serve` | `ollama` as a library |

Pick one. Mix all three.

---

## The without / with comparison

```typescript
// ❌ Without otterly — pay Anthropic twice
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ apiKey: "sk-ant-..." });          // $3 / MTok in
const res = await client.messages.create({                        // $15 / MTok out
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: "Fix the failing tests" }],
});
```

```typescript
// ✅ With otterly (library) — direct, in-process, $0
import { claude } from "otterly";
const result = await claude.run("Fix the failing tests", { cwd: "./app" });
console.log(result.text, result.cost);
```

```typescript
// ✅ With otterly (server) — your existing OpenAI SDK, any language, $0
import OpenAI from "openai";
const ai = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "unused" });
const res = await ai.chat.completions.create({
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: "Fix the failing tests" }],
});
```

That's the whole product. Keep reading if you want details.

---

## Install

```bash
npm install otterly
```

You also need Claude Code installed and signed in. Otterly auto-detects npm installs, Homebrew, and standalone binaries — anything that gives you a working `claude` command.

```bash
# Verify
claude --version
```

---

## Get your subscription back.

> *"Claude Code subscribers can no longer use their Claude subscription limits for third-party harnesses including OpenClaw."*
> — [TechCrunch](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/), April 4, 2026

If you use **OpenClaw**, this is the section that pays for otterly.

On **April 4, 2026**, Anthropic severed the direct path between OpenClaw and your Claude Code subscription. Overnight, OpenClaw users had three new (worse) options: buy extra usage bundles, supply a separate Anthropic API key at full pay-per-token rates, or drain a small parallel "Agent SDK credit" pool. Heavy users reported bills jumping up to **50× their previous monthly outlay**. The OpenClaw author publicly called it a betrayal.

otterly is the routing layer. OpenClaw talks to `localhost:11434`. otterly spawns your authenticated `claude` CLI — Anthropic's own product, still allowed to use your subscription — and the request arrives at the exact destination OpenClaw was locked out of. No extra bundles, no API key, no credit-pool draining. Same model, same brain, same subscription.

### Three steps. Then OpenClaw is yours again.

```bash
# 1. install Claude Code on the same machine, sign in once
npm i -g @anthropic-ai/claude-code
claude   # browser-based login, persists after

# 2. install + run otterly
npm i -g otterly
otterly serve   # listens on localhost:11434
```

```json5
// 3. add otterly as a model provider in your OpenClaw config
{
  agents: {
    defaults: { model: { primary: "otterly/claude-sonnet-4-20250514" } },
  },
  models: {
    providers: {
      otterly: {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "unused",
        api: "openai-completions",
        timeoutSeconds: 600,
        models: [{
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4 (via subscription)",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        }],
      },
    },
  },
}
```

```bash
openclaw models set otterly/claude-sonnet-4-20250514
```

That's the whole patch. Every OpenClaw call now lands on your Claude Code subscription via the local `claude` CLI. **The Agent SDK credit pool never moves, no API-key meter ticks, no extra-usage bundles get consumed.** Watch your Anthropic dashboard — the only thing that moves is your normal Claude Code subscription usage.

> **Running headless?** (Raspberry Pi, EC2, a container) — run `claude` once over an interactive SSH session to complete the browser login. The token persists. Then run `otterly serve` as a systemd user service. Same pattern as any long-lived daemon.

---

## Mode 1: Library — in-process, no server

Just import and call. Perfect for Node scripts, custom agents, cron jobs, build tools.

```typescript
import { claude } from "otterly";

// One-shot
const result = await claude.run("Add validation to user.ts", { cwd: "./app" });
console.log(result.text);   // assistant reply
console.log(result.cost);   // USD cost for this turn (tracked from Claude Code)
console.log(result.tools);  // every tool call Claude made

// Stream tokens
for await (const event of claude.stream("Refactor auth", { cwd: "." })) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "tool_use") console.log(`\n[using ${event.tool}]`);
}

// Multi-turn session — context persists in-memory, no server
const session = claude.session({ cwd: "./app" });
await session.send("Create a REST API");
await session.send("Now add auth to it");   // remembers the API you just built
session.close();
```

Sessions run entirely in-process. No WebSocket. No HTTP. The async generator stays alive between `send()` calls and keeps Claude's working context warm. As lightweight as a function call.

---

## Mode 2: CLI server — the Ollama experience

When you want one running daemon that **any tool, any language, any framework** can talk to.

```bash
npx otterly serve
```

That's it. Now you have an OpenAI-compatible API on `localhost:11434`. Point anything at it:

```typescript
// TypeScript — the OpenAI SDK
import OpenAI from "openai";
const ai = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "unused" });
const res = await ai.chat.completions.create({
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: "Write a haiku about otters" }],
});
```

```python
# Python — the OpenAI SDK
from openai import OpenAI
ai = OpenAI(base_url="http://localhost:11434/v1", api_key="unused")
res = ai.chat.completions.create(
  model="claude-sonnet-4-20250514",
  messages=[{"role": "user", "content": "Write a haiku about otters"}],
)
```

```bash
# Anything that speaks HTTP — curl, your shell, your dog
curl -X POST http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

It works in Cursor, Continue, Aider, Open WebUI, LiteLLM, LangChain, llamafile UIs, your own clients — anything with a `baseURL` field. If it talks to OpenAI, it talks to otterly.

Open the **playground** at [http://localhost:11434/playground](http://localhost:11434/playground) to poke the API from your browser.

---

## Mode 3: Embedded server — programmatic, no CLI

Run the full HTTP + WebSocket server **inside your own Node app**. Same endpoints, same playground, same WebSocket sessions — but no separate process to babysit.

```typescript
import { startApiServer } from "otterly";

const handle = await startApiServer({
  port: 11434,
  workingDir: "./my-project",
  maxConcurrent: 5,
});

// handle.server   → Node http.Server
// handle.wss      → WebSocketServer
// handle.port     → bound port
// handle.shutdown → graceful drain + close

// later, on app exit
await handle.shutdown(10_000);
```

This is exactly what `npx otterly serve` runs under the hood. Bundle it inside an Electron app, an internal dev tool, a Tauri sidecar, a Cloudflare-style edge worker — anything that benefits from an AI endpoint without managing a second process.

---

## What you get with the server

| Endpoint | Format | What it's for |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | Drop-in for any OpenAI client/SDK |
| `POST /api/run` | JSON | Native one-shot with cost + tool logs |
| `POST /api/stream` | NDJSON | Streaming with rich events |
| `WS /ws` | WebSocket | Persistent multi-turn sessions |
| `GET /playground` | HTML | Interactive API explorer in your browser |
| `GET /api/status` | JSON | Health + queue stats |
| `GET /swagger.json` | OpenAPI 3.0 | Full spec — generate a client in any language |

Plus all the boring-but-essential stuff:

- **Concurrency control** — request queue prevents fork-bombing your machine
- **Rate limiting** — per-IP token bucket, configurable
- **Circuit breaker** — bails out on cascading Claude Code failures
- **Auth** — set `OTTERLY_API_KEY` to require `Bearer` tokens
- **Graceful shutdown** — drains in-flight requests before exiting
- **CORS** — works straight from the browser

---

## Server config

```bash
npx otterly serve --port 11434 --dir ./project --max-concurrent 3
```

| Flag | Default | |
|---|---|---|
| `-p, --port` | `11434` | Port to listen on |
| `-d, --dir` | cwd | Working directory Claude runs in |
| `--max-concurrent` | `5` | Parallel Claude processes |
| `--max-queue` | `50` | Max queued requests |
| `--rate-limit` | `60` | Requests/min per client |

Programmatic options on `startApiServer()` mirror the flags, plus `requestTimeoutMs` and `streamTimeoutMs`. Set `OTTERLY_API_KEY` in the environment to require Bearer auth.

---

## Library API at a glance

```typescript
import { claude, ClaudeEngine, READONLY, AUTOPILOT } from "otterly";

// One-shot
const result = await claude.run(prompt, options);
// → { text, cost, duration, sessionId, usage, tools }

// Streaming
for await (const event of claude.stream(prompt, options)) {
  // event.type: text_delta | tool_use | tool_result | system | result | error
}

// Multi-turn session (in-process)
const session = claude.session(options);
await session.send(message);   // → AgentResult
session.close();

// Custom engine with defaults
const engine = new ClaudeEngine({ model: "claude-sonnet-4-20250514", maxTurns: 10 });

// Permission modes
await claude.run(prompt, { permissionMode: READONLY });   // read-only
await claude.run(prompt, { permissionMode: AUTOPILOT });  // full auto

// Embedded server
import { startApiServer } from "otterly";
const handle = await startApiServer({ port: 11434 });
```

---

## Why this is allowed to exist

Otterly is a **transport layer**. It does not jailbreak Claude, does not bypass any usage limits, does not redistribute model weights, does not store your prompts. Every request flows through your **own** authenticated Claude Code installation, subject to your subscription's normal limits.

What you save is the *second meter* — the per-token API bill on top of the subscription you already pay.

Why is it called "otterly"? Because otters carry their tools with them, and your local Claude already has all the tools it needs. Also because the domain was available.

---

## Requirements

- **Node.js 18+**
- **Claude Code** installed and signed in (`claude --version` to confirm)
- An active Claude subscription (Pro, Max, or Team)

---

## Contributing

PRs and issues welcome at [github.com/josharsh/otterly](https://github.com/josharsh/otterly). Especially interested in:

- More language SDK examples (Go, Rust, Elixir)
- Integration recipes for Cursor / Continue / Aider / Open WebUI
- Bugs from running it in production-ish environments

---

## License

MIT. Use it for anything, ship it anywhere, don't blame me when an otter gets in your codebase.
