import { describe, it, expect } from "vitest";
import { normalizeEvents, createEventContext } from "../src/events.js";

const delta = (d: Record<string, unknown>) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: d },
});

describe("normalizeEvents thinking deltas", () => {
  it("emits one thinking_delta for non-empty thinking", () => {
    const events = normalizeEvents(delta({ type: "thinking_delta", thinking: "Considering options." }), createEventContext());
    expect(events).toEqual([{ type: "thinking_delta", delta: "Considering options." }]);
  });

  it("emits nothing for empty thinking", () => {
    expect(normalizeEvents(delta({ type: "thinking_delta", thinking: "" }), createEventContext())).toEqual([]);
  });

  it("emits nothing for signature_delta", () => {
    expect(normalizeEvents(delta({ type: "signature_delta", signature: "abc" }), createEventContext())).toEqual([]);
  });

  it("leaves text_delta unchanged", () => {
    expect(normalizeEvents(delta({ type: "text_delta", text: "Hi" }), createEventContext())).toEqual([{ type: "text_delta", delta: "Hi" }]);
  });
});
