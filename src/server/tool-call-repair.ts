// Structural repair of a malformed tool-call envelope.
//
// The prompt-based function-calling bridge (see openai-compat.ts) asks the
// model to emit a `{"tool_calls": [...]}` object as its entire reply. When the
// model gets that JSON slightly wrong, parseToolCalls returns null and the raw
// text would otherwise reach the client as an ordinary prose answer, silently
// ending its agent loop.
//
// In practice the ONLY observed defect is a single missing closing bracket: the
// model finishes its content and miscounts the closers. This module repairs
// exactly that case and nothing else.

import type { ParsedToolCall } from "./openai-compat.js";

/** Result of a successful structural repair of a tool-call envelope. */
export interface RepairedToolCalls {
  calls: ParsedToolCall[];
  /** Human-readable description of each repair applied. */
  repairs: string[];
  /** How many characters the repair added or removed. */
  charsAltered: number;
}

/** Strip a code fence that wraps the ENTIRE reply, and trim. */
function stripWholeReplyFence(text: string): string {
  const s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : s;
}

/**
 * True when the reply *begins* as a tool-call envelope. Distinguishes "the
 * model set out to call a tool and got it wrong" from "the model answered in
 * prose". Prose that merely quotes or discusses a tool_calls object never
 * matches, because such an answer always has text around the JSON.
 */
export function looksLikeToolCallEnvelope(text: string): boolean {
  if (!text) return false;
  return /^\{\s*"tool_calls"\s*:/.test(stripWholeReplyFence(text));
}

/**
 * Repair a tool-call envelope that is complete except for ONE missing closing
 * bracket. Returns null when the text is not a repairable envelope.
 *
 * Safety properties, by construction:
 *  - No string is ever read or modified. Every `"..."` is opaque to the scanner,
 *    so a command, path or prompt argument is byte-for-byte what the model wrote.
 *  - Only `}` and `]` characters are touched, and only in the trailing run.
 *  - Output truncated mid-value ends inside a string, which is rejected here, so
 *    a cut-short argument is never "completed" into a shorter, different value.
 *  - Exactly one closer may be missing. Anything else is rejected.
 *  - The result must strictly parse AND match the envelope shape, or the whole
 *    repair is discarded.
 */
export function repairToolCalls(text: string): RepairedToolCalls | null {
  if (!text) return null;
  const s = stripWholeReplyFence(text);

  // The envelope must be the entire reply: it starts with {"tool_calls": ...
  if (!/^\{\s*"tool_calls"\s*:/.test(s)) return null;
  // ...and ends with a closing bracket. Trailing prose disqualifies it.
  if (!/[}\]]$/.test(s)) return null;

  // Split off the maximal trailing run of closers and whitespace.
  let runStart = s.length;
  while (runStart > 0 && /[}\]\s]/.test(s[runStart - 1])) runStart--;
  const head = s.slice(0, runStart);
  const actualRun = s.slice(runStart).replace(/\s+/g, "");
  if (!actualRun) return null;

  // String-aware scan of the head, collecting the closers still owed.
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null; // mismatched closer
    }
  }
  // Truncated mid-value: refuse. This is the case that could otherwise turn a
  // cut-short command into a shorter, materially different one.
  if (inStr || esc) return null;

  const required = stack.slice().reverse().join("");
  if (!required) return null;

  // The emitted run must be the required completion with exactly ONE character
  // deleted. Not "close whatever is open" -- one character, no more.
  let deletionIndex = -1;
  for (let i = 0; i < required.length; i++) {
    if (required.slice(0, i) + required.slice(i + 1) === actualRun) {
      deletionIndex = i;
      break;
    }
  }
  if (deletionIndex === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(head + required);
  } catch {
    return null;
  }

  const calls = validateToolCallEnvelope(parsed);
  if (!calls) return null;

  return {
    calls,
    repairs: ["inserted 1 missing closing bracket"],
    charsAltered: 1,
  };
}

/**
 * Accept only the exact envelope shape: {"tool_calls":[{name, arguments?}, ...]}.
 * Any extra key, any wrong type, and the repair is discarded.
 */
function validateToolCallEnvelope(parsed: unknown): ParsedToolCall[] | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "tool_calls") return null;

  const raw = (parsed as { tool_calls: unknown }).tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const calls: ParsedToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (k !== "name" && k !== "arguments") return null;
    }
    if (typeof e.name !== "string" || !e.name) return null;
    const args = e.arguments === undefined ? {} : e.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    calls.push({ name: e.name, arguments: args as Record<string, unknown> });
  }
  return calls;
}
