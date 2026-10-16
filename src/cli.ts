#!/usr/bin/env node

// `otterly serve` — CLI entry point.
// Uses node:util parseArgs (built-in since Node 18). No commander dependency.

import { parseArgs } from "node:util";
import { startApiServer } from "./server/index.js";
import { killAllChildren } from "./engine.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port:             { type: "string",  short: "p", default: "11435" },
    host:             { type: "string",  short: "H" },
    dir:              { type: "string",  short: "d" },
    "max-concurrent": { type: "string",  default: "5" },
    "max-queue":      { type: "string",  default: "50" },
    "queue-timeout":  { type: "string",  default: "120" },
    "request-timeout":{ type: "string" },
    "stream-timeout": { type: "string" },
    "idle-timeout":   { type: "string" },
    "rate-limit":     { type: "string",  default: "60" },

    help:             { type: "boolean", short: "h", default: false },
    version:          { type: "boolean", short: "v", default: false },
  },
});

const command = positionals[0] || "serve";

if (values.version) {
  console.log("0.6.0");
  process.exit(0);
}

if (values.help || command === "help") {
  console.log(`
  otterly — local inference server for Claude Code

  Usage:
    otterly serve [options]     Start the API server
    otterly help                Show this help

  Options:
    -p, --port <number>         Port to listen on (default: 11435)
    -H, --host <address>        Interface to listen on (default: all interfaces)
    -d, --dir <path>            Working directory (default: a clean scratch dir)
    --max-concurrent <number>   Max concurrent requests (default: 5)
    --max-queue <number>        Max queued requests (default: 50)
    --queue-timeout <seconds>   Max time a request waits in queue before 408 (default: 120)
    --request-timeout <seconds> Max time for a non-streamed request before 504 (default: 2700)
    --stream-timeout <seconds>  Max time for a streamed request before 504 (default: 2700)
    --idle-timeout <seconds>    Stop a Claude run after this long with no output (default: 300)
    --rate-limit <number>       Requests per minute per client (default: 60)

    -v, --version               Print version
    -h, --help                  Show this help

  Environment:
    OTTERLY_API_KEY       Set to require Bearer auth on all requests

    OTTERLY_REQUEST_TIMEOUT  Seconds; used when --request-timeout is not given
    OTTERLY_STREAM_TIMEOUT   Seconds; used when --stream-timeout is not given
    OTTERLY_IDLE_TIMEOUT     Seconds; used when --idle-timeout is not given

  Endpoints:
    POST /v1/chat/completions   OpenAI-compatible (use any OpenAI client)
    POST /api/run               Native one-shot execution
    POST /api/stream            Native NDJSON streaming
    GET  /api/status            Health check + queue/circuit stats
    GET  /api/quota             Claude subscription usage (5-hour and weekly)
    GET  /playground            Interactive API playground
    WS   /ws                    Multi-turn WebSocket sessions
`);
  process.exit(0);
}

if (command === "serve") {
  // A flag takes precedence over its environment variable. Values are seconds.
  const timeoutMs = (flag: string | undefined, envName: string): number | undefined => {
    const raw = flag ?? process.env[envName];
    if (raw === undefined || raw === "") return undefined;
    const secs = Number(raw);
    if (!Number.isFinite(secs) || secs <= 0) {
      console.error(`Invalid timeout "${raw}" (${envName} or its flag): must be a positive number of seconds.`);
      process.exit(1);
    }
    return Math.round(secs * 1000);
  };

  startApiServer({
    port: parseInt(values.port!, 10),
    host: values.host,
    workingDir: values.dir,
    maxConcurrent: parseInt(values["max-concurrent"]!, 10),
    maxQueueSize: parseInt(values["max-queue"]!, 10),
    queueTimeoutMs: parseInt(values["queue-timeout"]!, 10) * 1000,
    requestsPerMinute: parseInt(values["rate-limit"]!, 10),
    requestTimeoutMs: timeoutMs(values["request-timeout"], "OTTERLY_REQUEST_TIMEOUT"),
    streamTimeoutMs: timeoutMs(values["stream-timeout"], "OTTERLY_STREAM_TIMEOUT"),
    idleTimeoutMs: timeoutMs(values["idle-timeout"], "OTTERLY_IDLE_TIMEOUT"),
  }).then((handle) => {
    // Graceful shutdown on SIGTERM/SIGINT
    let shutdownInitiated = false;
    const onSignal = async () => {
      if (shutdownInitiated) {
        console.log("\nForced exit.");
        killAllChildren("SIGKILL");
        process.exit(1);
      }
      shutdownInitiated = true;
      // Claude CLI children run in their own process groups, so the terminal's
      // Ctrl+C never reaches them. Stop them explicitly, or they outlive the
      // server as orphans.
      killAllChildren("SIGTERM");
      await handle.shutdown(10_000);
      killAllChildren("SIGKILL");
      process.exit(0);
    };

    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }).catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}. Run 'otterly help' for usage.`);
  process.exit(1);
}
