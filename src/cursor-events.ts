/**
 * cursor-events.ts
 *
 * Pure, dependency-free parser that converts a single Cursor NDJSON event
 * object into zero or more AgentEvent values, tracking minimal cross-event
 * state for duplicate suppression.
 *
 * This module NEVER throws on malformed input — every code path either
 * produces a valid AgentEvent array or returns [].
 */

import { randomUUID } from "crypto";
import type { AgentEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

/**
 * Mutable state carried across the events that belong to one Cursor
 * invocation.  A fresh CursorParseState must be created per request so
 * that requests are completely isolated from each other.
 */
export interface CursorParseState {
  /** Set to true once the first streaming text_delta has been yielded.
   *  Used to suppress the final consolidated `assistant` message which
   *  otherwise duplicates the content already sent via deltas. */
  sawTextDelta: boolean;
  /** Session identifier carried from the `system` event. */
  sessionId: string;
  /** Model name carried from the `system` event. */
  model: string;
  /** Working directory carried from the `system` event. */
  cwd: string;
}

/** Returns a fresh, zero-valued parse state for a new Cursor invocation. */
export function createCursorParseState(): CursorParseState {
  return { sawTextDelta: false, sessionId: "", model: "", cwd: "" };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Produces a string from an arbitrary value intended as tool output.
 * Returns the value unchanged when it is already a string; JSON-stringifies
 * anything else.  Falls back to "" if serialisation throws.
 */
function stringifyOutput(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/**
 * Generates a short random id suitable for a tool-call identifier when the
 * Cursor event does not supply one.
 */
function randomId(): string {
  return randomUUID();
}

/**
 * Defensively extracts a text string from a Cursor message object.
 *
 * Tries four strategies in order:
 *  1. message.content is an array  -> concatenate every element's .text string.
 *  2. message.content is a plain string -> return it directly.
 *  3. message.text is a string -> return it directly.
 *  4. Everything else -> return "".
 *
 * Any property-access error also yields "".
 */
function extractText(message: unknown): string {
  try {
    if (message == null || typeof message !== "object") return "";
    const msg = message as Record<string, unknown>;

    // Strategy 1: content array (OpenAI-style content blocks).
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((part) => {
          if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            return typeof p.text === "string" ? p.text : "";
          }
          return "";
        })
        .join("");
    }

    // Strategy 2: content plain string.
    if (typeof msg.content === "string") return msg.content;

    // Strategy 3: top-level text field.
    if (typeof msg.text === "string") return msg.text;

    return "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Main normaliser
// ---------------------------------------------------------------------------

/**
 * Converts one parsed Cursor NDJSON event object into zero or more AgentEvent
 * values, updating `state` in place as a side-effect.
 *
 * The caller is responsible for:
 *  - JSON-parsing each raw NDJSON line before passing the result here.
 *  - Providing the same `state` instance for every event in a single
 *    invocation so that cross-event logic (delta suppression, sessionId
 *    propagation) works correctly.
 */
export function normalizeCursorEvent(
  raw: Record<string, unknown>,
  state: CursorParseState,
): AgentEvent[] {
  try {
    switch (raw.type) {
      // ------------------------------------------------------------------ //
      // system — session bootstrap metadata                                 //
      // ------------------------------------------------------------------ //
      case "system": {
        const sessionId = typeof raw.session_id === "string" ? raw.session_id : String(raw.session_id ?? "");
        const model     = typeof raw.model       === "string" ? raw.model       : String(raw.model       ?? "");
        const cwd       = typeof raw.cwd         === "string" ? raw.cwd         : String(raw.cwd         ?? "");

        state.sessionId = sessionId;
        state.model     = model;
        state.cwd       = cwd;

        return [{ type: "system", sessionId, model, cwd, tools: [] }];
      }

      // ------------------------------------------------------------------ //
      // user — echo of our own prompt; nothing to yield                     //
      // ------------------------------------------------------------------ //
      case "user": {
        return [];
      }

      // ------------------------------------------------------------------ //
      // assistant — either a streaming delta or the final consolidated msg  //
      // ------------------------------------------------------------------ //
      case "assistant": {
        const text = extractText(raw.message);

        if ("timestamp_ms" in raw) {
          // Streaming delta path: timestamp_ms presence signals a partial chunk.
          if (text !== "") {
            state.sawTextDelta = true;
            return [{ type: "text_delta", delta: text }];
          }
          return [];
        } else {
          // Final consolidated message path.
          if (state.sawTextDelta) {
            // Suppress: the content has already been delivered via deltas.
            return [];
          }
          if (text !== "") {
            return [{ type: "text", text }];
          }
          return [];
        }
      }

      // ------------------------------------------------------------------ //
      // tool_call — best-effort mapping                                     //
      // Q2: field names are provisional pending a real live sample.         //
      //     Verify call_id / name / args / result against actual output     //
      //     before relying on tool-use forwarding in production.            //
      // ------------------------------------------------------------------ //
      case "tool_call": {
        // Gather the most likely id/name fields, trying several aliases.
        const callId = String(
          raw.call_id ?? raw.id ?? raw.tool_call_id ?? randomId(),
        );
        const toolName = String(raw.name ?? raw.tool ?? "unknown");

        // Determine whether this event represents a completed tool call.
        const hasResult =
          raw.result !== undefined ||
          raw.output !== undefined;
        const completedByStatus =
          raw.status === "completed" ||
          raw.status === "success" ||
          raw.subtype === "completed";

        if (completedByStatus || hasResult) {
          // Tool completed — emit a tool_result event.
          const output = stringifyOutput(raw.result ?? raw.output ?? "");
          const isError = Boolean(raw.is_error ?? false);
          return [
            {
              type: "tool_result",
              toolUseId: callId,
              tool: toolName,
              output,
              isError,
            },
          ];
        }

        // Tool started (no result present) — emit a tool_use event.
        const input = (raw.args ?? raw.arguments ?? raw.input ?? {}) as Record<string, unknown>;
        return [
          {
            type: "tool_use",
            id: callId,
            tool: toolName,
            input,
            description: "",
          },
        ];
      }

      // ------------------------------------------------------------------ //
      // result — terminal event summarising the full invocation             //
      // ------------------------------------------------------------------ //
      case "result": {
        const usage = raw.usage as Record<string, unknown> | undefined;
        return [
          {
            type: "result",
            text: String(raw.result ?? ""),
            cost: 0, // Cursor does not expose cost information.
            duration: Number(raw.duration_ms ?? 0),
            sessionId: String(raw.session_id ?? state.sessionId),
            usage: {
              input_tokens:  Number(usage?.inputTokens  ?? 0),
              output_tokens: Number(usage?.outputTokens ?? 0),
            },
          },
        ];
      }

      // ------------------------------------------------------------------ //
      // Unknown event types — silently discard.                             //
      // ------------------------------------------------------------------ //
      default: {
        return [];
      }
    }
  } catch {
    // Never propagate errors; return an empty list so the caller can continue
    // processing subsequent lines.
    return [];
  }
}
