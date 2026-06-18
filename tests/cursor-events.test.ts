/**
 * cursor-events.test.ts
 *
 * Unit tests for the Cursor NDJSON event parser (src/cursor-events.ts).
 *
 * Uses the exact event stream described in AGENTS.md §3.4 for the primary
 * streaming-delta test case, then covers no-delta, malformed, and
 * usage-defaults scenarios.
 */

import { describe, it, expect } from "vitest";
import {
  createCursorParseState,
  normalizeCursorEvent,
} from "../src/cursor-events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Runs every event in `events` through the parser with a shared state and
 *  returns the flat list of all AgentEvents produced. */
function run(events: Record<string, unknown>[]) {
  const state = createCursorParseState();
  return events.flatMap((ev) => normalizeCursorEvent(ev, state));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("normalizeCursorEvent", () => {
  // ------------------------------------------------------------------------
  // 1. Streamed deltas + suppressed consolidated (AGENTS.md §3.4 sequence)
  // ------------------------------------------------------------------------
  it("yields text_deltas from streaming assistant events and suppresses the consolidated assistant", () => {
    const events: Record<string, unknown>[] = [
      // system bootstrap
      {
        type: "system",
        session_id: "sess-abc",
        model: "composer-2.5",
        cwd: "/tmp/project",
      },
      // user echo
      { type: "user", message: { content: "List 3 colours" } },
      // four streaming deltas (timestamp_ms present = delta)
      { type: "assistant", timestamp_ms: 1000, message: { content: "1" } },
      { type: "assistant", timestamp_ms: 2000, message: { content: ". Red  \n" } },
      { type: "assistant", timestamp_ms: 3000, message: { content: "2. Blue  \n" } },
      { type: "assistant", timestamp_ms: 4000, message: { content: "3. Green" } },
      // final consolidated assistant (no timestamp_ms) — must be suppressed
      {
        type: "assistant",
        message: { content: "1. Red  \n2. Blue  \n3. Green" },
      },
      // result
      {
        type: "result",
        result: "1. Red  \n2. Blue  \n3. Green",
        session_id: "sess-abc",
        duration_ms: 6664,
        usage: { inputTokens: 3729, outputTokens: 46 },
      },
    ];

    const state = createCursorParseState();
    const allEvents = events.flatMap((ev) => normalizeCursorEvent(ev, state));

    // system event
    expect(allEvents[0]).toEqual({
      type: "system",
      sessionId: "sess-abc",
      model: "composer-2.5",
      cwd: "/tmp/project",
      tools: [],
    });

    // user yields nothing; next is the first delta at index 1

    // four text_delta events
    expect(allEvents[1]).toEqual({ type: "text_delta", delta: "1" });
    expect(allEvents[2]).toEqual({ type: "text_delta", delta: ". Red  \n" });
    expect(allEvents[3]).toEqual({ type: "text_delta", delta: "2. Blue  \n" });
    expect(allEvents[4]).toEqual({ type: "text_delta", delta: "3. Green" });

    // consolidated assistant is suppressed (sawTextDelta = true)
    // result lands at index 5
    expect(allEvents[5]).toEqual({
      type: "result",
      text: "1. Red  \n2. Blue  \n3. Green",
      cost: 0,
      duration: 6664,
      sessionId: "sess-abc",
      usage: { input_tokens: 3729, output_tokens: 46 },
    });

    // Total: system(1) + deltas(4) + result(1) = 6
    expect(allEvents).toHaveLength(6);
  });

  // ------------------------------------------------------------------------
  // 2. No-delta mode — single full assistant message (no timestamp_ms)
  // ------------------------------------------------------------------------
  it("emits a text event when there are no deltas (no sawTextDelta suppression)", () => {
    const events: Record<string, unknown>[] = [
      {
        type: "system",
        session_id: "sess-xyz",
        model: "gpt-5.5",
        cwd: "/home/user",
      },
      // Single consolidated assistant, no streaming deltas before it.
      {
        type: "assistant",
        message: { content: "The answer is 42." },
      },
      {
        type: "result",
        result: "The answer is 42.",
        session_id: "sess-xyz",
        duration_ms: 800,
        usage: { inputTokens: 10, outputTokens: 8 },
      },
    ];

    const produced = run(events);

    expect(produced[0]).toEqual({
      type: "system",
      sessionId: "sess-xyz",
      model: "gpt-5.5",
      cwd: "/home/user",
      tools: [],
    });

    // No deltas seen, so the consolidated assistant emits a text event.
    expect(produced[1]).toEqual({ type: "text", text: "The answer is 42." });

    expect(produced[2]).toEqual({
      type: "result",
      text: "The answer is 42.",
      cost: 0,
      duration: 800,
      sessionId: "sess-xyz",
      usage: { input_tokens: 10, output_tokens: 8 },
    });

    expect(produced).toHaveLength(3);
  });

  // ------------------------------------------------------------------------
  // 3. Malformed / unknown inputs — must never throw
  // ------------------------------------------------------------------------
  it("handles malformed and unknown event types without throwing", () => {
    const state = createCursorParseState();

    // assistant with no message field at all
    expect(() => normalizeCursorEvent({ type: "assistant" }, state)).not.toThrow();
    const noMsg = normalizeCursorEvent({ type: "assistant" }, state);
    expect(noMsg).toEqual([]);

    // completely unknown event type
    expect(() => normalizeCursorEvent({ type: "weird", data: "x" }, state)).not.toThrow();
    const unknown = normalizeCursorEvent({ type: "weird", data: "x" }, state);
    expect(unknown).toEqual([]);

    // assistant whose message uses the .text path (not .content)
    // sawTextDelta is still false at this point, so text event is emitted.
    const textPath = normalizeCursorEvent(
      { type: "assistant", message: { text: "hello via text field" } },
      state,
    );
    expect(textPath).toEqual([{ type: "text", text: "hello via text field" }]);
  });

  // ------------------------------------------------------------------------
  // 4. Usage / zero defaults — missing fields fall back to 0
  // ------------------------------------------------------------------------
  it("defaults usage and duration to 0 when absent from a result event", () => {
    const state = createCursorParseState();

    const [ev] = normalizeCursorEvent(
      { type: "result", result: "done" },
      state,
    );

    expect(ev).toEqual({
      type: "result",
      text: "done",
      cost: 0,
      duration: 0,
      sessionId: "",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });
});
