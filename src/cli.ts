#!/usr/bin/env node

// `otterly serve` — CLI entry point.
// Uses node:util parseArgs (built-in since Node 18). No commander dependency.

import { parseArgs } from "node:util";
import { startApiServer } from "./server/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", short: "p", default: "11434" },
    dir: { type: "string", short: "d", default: process.cwd() },
    "max-concurrent": { type: "string", default: "5" },
    "max-queue": { type: "string", default: "50" },
    "rate-limit": { type: "string", default: "60" },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
});

const command = positionals[0] || "serve";

if (values.version) {
  console.log("0.4.1");
  process.exit(0);
}

if (values.help || command === "help") {
  console.log(`
  otterly — local inference server for Claude Code

  Usage:
    otterly serve [options]     Start the API server
    otterly help                Show this help

  Options:
    -p, --port <number>         Port to listen on (default: 11434)
    -d, --dir <path>            Working directory for Claude (default: cwd)
    --max-concurrent <number>   Max concurrent requests (default: 5)
    --max-queue <number>        Max queued requests (default: 50)
    --rate-limit <number>       Requests per minute per client (default: 60)
    -v, --version               Print version
    -h, --help                  Show this help

  Environment:
    OTTERLY_API_KEY       Set to require Bearer auth on all requests

  Endpoints:
    POST /v1/chat/completions   OpenAI-compatible (use any OpenAI client)
    POST /api/run               Native one-shot execution
    POST /api/stream            Native NDJSON streaming
    GET  /api/status            Health check + queue/circuit stats
    GET  /playground            Interactive API playground
    WS   /ws                    Multi-turn WebSocket sessions
`);
  process.exit(0);
}

if (command === "serve") {
  startApiServer({
    port: parseInt(values.port!, 10),
    workingDir: values.dir,
    maxConcurrent: parseInt(values["max-concurrent"]!, 10),
    maxQueueSize: parseInt(values["max-queue"]!, 10),
    requestsPerMinute: parseInt(values["rate-limit"]!, 10),
  }).then((handle) => {
    // Graceful shutdown on SIGTERM/SIGINT
    let shutdownInitiated = false;
    const onSignal = async () => {
      if (shutdownInitiated) {
        console.log("\nForced exit.");
        process.exit(1);
      }
      shutdownInitiated = true;
      await handle.shutdown(10_000);
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
