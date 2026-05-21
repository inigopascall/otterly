// WebSocket handler for /ws — multi-turn sessions.
// Each connection gets its own otterly Session.
// Includes heartbeats: ping/pong with 30s interval, 10s timeout.

import type { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import { ClaudeEngine } from "../engine.js";
import { Session } from "../session.js";
import type { EngineOptions, AgentEvent } from "../types.js";
import { apiSessions } from "./session-store.js";

interface WsMessage {
  type: "chat" | "cancel" | "resume" | "new_session";
  text?: string;
  sessionId?: string;
  options?: Record<string, unknown>;
}

interface ConnectionState {
  session: Session | null;
  engine: ClaudeEngine;
  isAlive: boolean;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * Attach WebSocket handling to a WebSocketServer for the API server.
 */
export function attachWsHandler(wss: WebSocketServer, ctx: { workingDir: string }): void {
  // Heartbeat sweep: ping all connections every 30s
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      const extWs = ws as WebSocket & { _otterlyState?: ConnectionState };
      const state = extWs._otterlyState;
      if (state && !state.isAlive) {
        // No pong received since last ping — terminate
        ws.terminate();
        continue;
      }
      if (state) {
        state.isAlive = false;
      }
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  wss.on("connection", (ws: WebSocket) => {
    const connId = crypto.randomUUID().slice(0, 8);

    const state: ConnectionState = {
      session: null,
      engine: new ClaudeEngine({ cwd: ctx.workingDir, permissionMode: "bypassPermissions" }),
      isAlive: true,
    };

    // Attach state to ws for heartbeat access
    (ws as WebSocket & { _otterlyState?: ConnectionState })._otterlyState = state;

    apiSessions.create(connId, { state });

    function send(obj: unknown): void {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
      }
    }

    // Pong handler: mark connection as alive
    ws.on("pong", () => {
      state.isAlive = true;
    });

    ws.on("message", async (raw: Buffer) => {
      state.isAlive = true; // any message counts as alive

      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ kind: "error", code: "INVALID_JSON", message: "Invalid JSON" });
        return;
      }

      if (msg.type === "chat") {
        await handleChat(msg, state, send, ctx);
      } else if (msg.type === "cancel") {
        if (state.session) {
          state.session.close();
          state.session = null;
        }
        send({ kind: "status", status: "ready" });
      } else if (msg.type === "resume") {
        // Close existing session and create new one with resume
        if (state.session) {
          state.session.close();
        }
        const opts: EngineOptions = {
          cwd: ctx.workingDir,
          permissionMode: "bypassPermissions",
        };
        if (msg.sessionId) {
          opts.resume = msg.sessionId;
        }
        state.session = state.engine.session(opts);
        send({ kind: "status", status: "ready" });
      } else if (msg.type === "new_session") {
        if (state.session) {
          state.session.close();
          state.session = null;
        }
        send({ kind: "status", status: "ready" });
      }
    });

    ws.on("close", () => {
      if (state.session) {
        state.session.close();
        state.session = null;
      }
      apiSessions.delete(connId);
    });
  });
}

async function handleChat(
  msg: WsMessage,
  state: ConnectionState,
  send: (obj: unknown) => void,
  ctx: { workingDir: string }
): Promise<void> {
  const text = msg.text || "";
  if (!text) {
    send({ kind: "error", code: "EMPTY_MESSAGE", message: "text is required" });
    return;
  }

  // Create session if not exists
  if (!state.session) {
    const opts: EngineOptions = {
      cwd: (msg.options?.cwd as string) || ctx.workingDir,
      permissionMode: (msg.options?.permissionMode as EngineOptions["permissionMode"]) || "bypassPermissions",
    };
    if (msg.options?.systemPrompt) opts.systemPrompt = msg.options.systemPrompt as string;
    if (msg.options?.model) opts.model = msg.options.model as string;
    state.session = state.engine.session(opts);
  }

  send({ kind: "status", status: "thinking" });

  try {
    for await (const event of state.session.sendStream(text)) {
      const payload = eventToWsPayload(event);
      if (payload) send(payload);
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    send({ kind: "error", code: "UNKNOWN", message: e.message });
  }

  send({ kind: "status", status: "ready" });
}

function eventToWsPayload(event: AgentEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "system":
      return { kind: "session_init", sessionId: event.sessionId, model: event.model };
    case "text_delta":
      return { kind: "text_delta", delta: event.delta };
    case "text":
      return { kind: "text", text: event.text };
    case "tool_use":
      return { kind: "tool_use", id: event.id, tool: event.tool, input: event.input, description: event.description };
    case "tool_result":
      return { kind: "tool_result", toolUseId: event.toolUseId, tool: event.tool, output: event.output, isError: event.isError };
    case "result":
      return { kind: "result", text: event.text, cost: event.cost, duration: event.duration, sessionId: event.sessionId, usage: event.usage };
    case "error":
      return { kind: "error", code: "EXECUTION_ERROR", message: event.error.message };
    default:
      return null;
  }
}
