// API server: HTTP + WebSocket, no Express.
// Mounts OpenAI-compatible and native routes on raw http.createServer.
// Includes: middleware chain, request queue, timeouts, logging, graceful shutdown.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { WebSocketServer } from "ws";
import { handleChatCompletions } from "./routes-openai.js";
import { handleStatus, handleRun, handleStream, type ParsedRequest, type ServerContext } from "./routes-native.js";
import { attachWsHandler } from "./ws-handler.js";
import { apiSessions } from "./session-store.js";
import { RequestQueue, QueueFullError, QueueTimeoutError } from "./request-queue.js";
import { checkAuth, RateLimiter, sendAuthError, sendRateLimitError } from "./middleware.js";
import { generateRequestId, logRequest, logResponse, logError } from "./logger.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { openApiSpec } from "./swagger.js";
import { getPlaygroundHtml } from "./playground.js";

/**
 * Parse JSON body from an incoming request. Returns parsed object or null on failure.
 */
function parseBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 20 * 1024 * 1024; // 20MB

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });

    req.on("error", () => resolve(null));
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
  }
  res.end(JSON.stringify(body));
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");
}

export interface ApiServerOptions {
  port?: number;
  workingDir?: string;
  maxConcurrent?: number;
  maxQueueSize?: number;
  requestsPerMinute?: number;
  requestTimeoutMs?: number;
  streamTimeoutMs?: number;
}

export interface ApiServerHandle {
  server: Server;
  wss: WebSocketServer;
  port: number;
  close(): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

export async function startApiServer(opts: ApiServerOptions = {}): Promise<ApiServerHandle> {
  const port = opts.port ?? 11434;
  const workingDir = opts.workingDir ?? process.cwd();
  const apiKey = process.env.OTTERLY_API_KEY || null;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5 * 60 * 1000;  // 5 min one-shot
  const streamTimeoutMs = opts.streamTimeoutMs ?? 10 * 60 * 1000;   // 10 min streaming

  const ctx: ServerContext = { workingDir, apiKey };
  const queue = new RequestQueue({
    maxConcurrent: opts.maxConcurrent,
    maxQueueSize: opts.maxQueueSize,
  });
  const rateLimiter = new RateLimiter({ requestsPerMinute: opts.requestsPerMinute });
  const circuitBreaker = new CircuitBreaker();

  // Track in-flight requests for graceful shutdown
  let inFlight = 0;
  let shuttingDown = false;
  let drainResolve: (() => void) | null = null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = generateRequestId();
    const startTime = Date.now();
    res.setHeader("X-Request-Id", requestId);
    setCors(res);

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // Log request start for POST requests
    if (req.method === "POST") {
      logRequest(requestId, req.method, path);
    }

    // Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Reject new requests during shutdown
    if (shuttingDown && req.method === "POST") {
      jsonResponse(res, 503, { error: "Server is shutting down" });
      return;
    }

    // GET /api/status — no auth, no rate limit, no queue
    if (req.method === "GET" && path === "/api/status") {
      handleStatus(req, res, queue, circuitBreaker);
      return;
    }

    // GET /swagger.json — OpenAPI spec, no auth
    if (req.method === "GET" && path === "/swagger.json") {
      jsonResponse(res, 200, openApiSpec);
      return;
    }

    // GET /playground — interactive API playground
    if (req.method === "GET" && path === "/playground") {
      const html = getPlaygroundHtml(port);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // GET / — server info
    if (req.method === "GET" && path === "/") {
      jsonResponse(res, 200, { name: "otterly", version: "0.4.1", playground: "/playground" });
      return;
    }

    // ── POST routes: auth → rate limit → circuit breaker → queue ──

    if (req.method !== "POST") {
      jsonResponse(res, 404, { error: "Not found" });
      return;
    }

    const isOpenai = path === "/v1/chat/completions";
    const format = isOpenai ? "openai" : "native" as const;

    // Auth
    if (!checkAuth(req, ctx)) {
      sendAuthError(res, format);
      logResponse(requestId, req.method!, path, 401, Date.now() - startTime);
      return;
    }

    // Rate limit
    if (!rateLimiter.allow(rateLimiter.keyFor(req))) {
      sendRateLimitError(res, format);
      logResponse(requestId, req.method!, path, 429, Date.now() - startTime);
      return;
    }

    // Circuit breaker
    if (!circuitBreaker.canProceed()) {
      const status = 503;
      jsonResponse(res, status, isOpenai
        ? { error: { message: "Service temporarily unavailable", type: "server_error", code: status } }
        : { error: "Service temporarily unavailable" }
      );
      logResponse(requestId, req.method!, path, status, Date.now() - startTime);
      return;
    }

    // Parse body
    const parsed = req as ParsedRequest;
    parsed.body = await parseBody(req) ?? undefined;
    if (parsed.body === undefined) {
      const status = 400;
      jsonResponse(res, status, isOpenai
        ? { error: { message: "Invalid JSON body", type: "invalid_request_error" } }
        : { error: "Invalid JSON body" }
      );
      logResponse(requestId, req.method!, path, status, Date.now() - startTime);
      return;
    }

    // Attach requestId and timing context for route handlers
    parsed.requestId = requestId;
    parsed.startTime = startTime;

    // Determine if streaming (affects timeout)
    const isStream = path === "/api/stream"
      || (isOpenai && parsed.body?.stream === true);
    const timeoutMs = isStream ? streamTimeoutMs : requestTimeoutMs;

    // Queue + execute with timeout
    try {
      await queue.run(async () => {
        inFlight++;
        try {
          await withTimeout(timeoutMs, parsed, async () => {
            if (isOpenai) {
              await handleChatCompletions(parsed, res, ctx, circuitBreaker);
            } else if (path === "/api/run") {
              await handleRun(parsed, res, ctx, circuitBreaker);
            } else if (path === "/api/stream") {
              await handleStream(parsed, res, ctx, circuitBreaker);
            } else {
              jsonResponse(res, 404, { error: "Not found" });
            }
          });
        } finally {
          inFlight--;
          const status = res.statusCode || 200;
          logResponse(requestId, req.method!, path, status, Date.now() - startTime);
          if (inFlight === 0 && drainResolve) drainResolve();
        }
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        jsonResponse(res, 429, isOpenai
          ? { error: { message: err.message, type: "rate_limit_error", code: 429 } }
          : { error: err.message }
        );
        logResponse(requestId, req.method!, path, 429, Date.now() - startTime);
      } else if (err instanceof QueueTimeoutError) {
        jsonResponse(res, 408, isOpenai
          ? { error: { message: err.message, type: "timeout_error", code: 408 } }
          : { error: err.message }
        );
        logResponse(requestId, req.method!, path, 408, Date.now() - startTime);
      } else if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(requestId, msg);
        jsonResponse(res, 500, isOpenai
          ? { error: { message: "Internal server error", type: "server_error", code: 500 } }
          : { error: "Internal server error" }
        );
      }
    }
  });

  // Node built-in timeouts (safety net)
  server.requestTimeout = 15 * 60 * 1000;   // 15 min absolute max
  server.headersTimeout = 30 * 1000;          // 30s to receive headers

  // WebSocket on /ws path
  const wss = new WebSocketServer({ server, path: "/ws" });
  attachWsHandler(wss, { workingDir });

  async function shutdown(timeoutMs = 10_000): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down gracefully...");

    // Stop accepting new connections
    server.close();
    wss.close();

    // Wait for in-flight to drain or timeout
    if (inFlight > 0) {
      console.log(`Waiting for ${inFlight} in-flight request(s)...`);
      await Promise.race([
        new Promise<void>((resolve) => { drainResolve = resolve; }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }

    // Clean up
    rateLimiter.destroy();
    apiSessions.destroy();
    console.log("Shutdown complete.");
  }

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${port} is in use. Try a different port with -p <port>.`);
      }
      reject(err);
    });

    server.listen(port, () => {
      console.log(`\n  otterly serve — local inference server`);
      console.log(`  ──────────────────────────────────────`);
      console.log(`  OpenAI compat : http://localhost:${port}/v1/chat/completions`);
      console.log(`  Native API    : http://localhost:${port}/api/run`);
      console.log(`  Streaming     : http://localhost:${port}/api/stream`);
      console.log(`  WebSocket     : ws://localhost:${port}/ws`);
      console.log(`  Health        : http://localhost:${port}/api/status`);
      console.log(`  Playground    : http://localhost:${port}/playground`);
      console.log(`  Working dir   : ${workingDir}`);
      if (apiKey) {
        console.log(`  Auth          : API key required (OTTERLY_API_KEY)`);
      } else {
        console.log(`  Auth          : none (set OTTERLY_API_KEY to enable)`);
      }
      console.log();

      resolve({
        server,
        wss,
        port,
        close() {
          rateLimiter.destroy();
          apiSessions.destroy();
          wss.close();
          server.close();
        },
        shutdown,
      });
    });
  });
}

/** Run a handler with an execution timeout. Aborts via the request's AbortController pattern. */
async function withTimeout(
  timeoutMs: number,
  req: ParsedRequest,
  fn: () => Promise<void>
): Promise<void> {
  // Attach a timeout abort controller that route handlers can pick up
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  req.timeoutSignal = timeoutController.signal;

  try {
    await fn();
  } finally {
    clearTimeout(timer);
  }
}
