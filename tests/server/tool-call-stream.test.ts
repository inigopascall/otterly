import { describe, it, expect } from "vitest";
import { ToolCallStreamer, reconcileStreamedCalls } from "../../src/server/tool-call-stream.js";

const ENVELOPE = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris","days":3}},{"name":"get_time","arguments":{"tz":"CET"}}]}';
const ARGS0 = { city: "Paris", days: 3 };
const ARGS1 = { tz: "CET" };

function feed(pieces: string[]): { s: ToolCallStreamer; actions: any[] } {
  const s = new ToolCallStreamer();
  const actions: any[] = [];
  for (const p of pieces) actions.push(...s.push(p));
  return { s, actions };
}

const chars = (t: string) => t.split("");
const content = (actions: any[]) => actions.filter((a) => a.type === "content").map((a) => a.text).join("");

function splitAt(text: string, points: number[]): string[] {
  const out: string[] = [];
  let from = 0;
  for (const p of points) { out.push(text.slice(from, p)); from = p; }
  out.push(text.slice(from));
  return out;
}

/** Returns a description of what is wrong with the actions for the two-call envelope, or null. */
function envelopeProblem(pieces: string[]): string | null {
  const { actions } = feed(pieces);
  const starts = actions.filter((a) => a.type === "tool_start").map((a) => `${a.index}:${a.name}`);
  if (starts.join(",") !== "0:get_weather,1:get_time") return `starts ${starts.join(",")}`;
  if (actions.some((a) => a.type === "content")) return "content sent";
  const args = new Map<number, string>();
  for (const a of actions) {
    if (a.type === "tool_start") args.set(a.index, (args.get(a.index) ?? "") + a.args);
    if (a.type === "tool_args") args.set(a.index, (args.get(a.index) ?? "") + a.text);
  }
  try {
    expect(JSON.parse(args.get(0) ?? "")).toEqual(ARGS0);
    expect(JSON.parse(args.get(1) ?? "")).toEqual(ARGS1);
  } catch {
    return `args ${JSON.stringify([...args.entries()])}`;
  }
  return null;
}

describe("ToolCallStreamer", () => {
  it("passes prose through unchanged", () => {
    const text = "Hello there. Use {x} as a placeholder; a < b too.";
    for (const pieces of [[text], chars(text), splitAt(text, [6, 20])]) {
      const { s, actions } = feed(pieces);
      expect(content(actions)).toBe(text);
      expect(actions.every((a) => a.type === "content")).toBe(true);
      expect(s.mode).toBe("prose");
      expect(s.unsent).toBe("");
    }
  });

  it("streams both calls for every two-way split of the envelope", () => {
    const failures: string[] = [];
    for (let i = 1; i < ENVELOPE.length; i++) {
      const p = envelopeProblem([ENVELOPE.slice(0, i), ENVELOPE.slice(i)]);
      if (p) failures.push(`split ${i}: ${p}`);
    }
    expect(failures).toEqual([]);
  });

  it("streams both calls for multi-way splits", () => {
    const L = ENVELOPE.length;
    const cases: string[][] = [
      [ENVELOPE],
      chars(ENVELOPE),
      splitAt(ENVELOPE, [10, 40]),
      splitAt(ENVELOPE, [5, 60, 90]),
      splitAt(ENVELOPE, [L - 2, L - 1]),
      [" \n", ...splitAt(ENVELOPE, [30, 70])],
    ];
    const failures = cases.map((c, i) => [i, envelopeProblem(c)]).filter(([, p]) => p);
    expect(failures).toEqual([]);
  });

  it("sends prose before an embedded envelope and holds the rest", () => {
    const prose = "Sure, I will check. ";
    const text = prose + ENVELOPE;
    for (const pieces of [[text], chars(text), splitAt(text, [prose.length + 3])]) {
      const { s, actions } = feed(pieces);
      expect(content(actions)).toBe(prose);
      expect(actions.some((a) => a.type !== "content")).toBe(false);
      expect(s.mode).toBe("held");
      expect(s.unsent).toBe(ENVELOPE);
    }
  });

  it("holds a reply that starts with a fenced envelope", () => {
    const text = "```json\n" + ENVELOPE + "\n```";
    for (const pieces of [[text], chars(text)]) {
      const { s, actions } = feed(pieces);
      expect(actions).toEqual([]);
      expect(s.mode).toBe("held");
      expect(s.unsent).toBe(text);
    }
  });

  it("holds a reply that starts with <invoke", () => {
    const text = '<invoke name="get_weather"><parameter name="city">Paris</parameter></invoke>';
    for (const pieces of [[text], chars(text)]) {
      const { s, actions } = feed(pieces);
      expect(actions).toEqual([]);
      expect(s.mode).toBe("held");
      expect(s.unsent).toBe(text);
    }
  });
});

describe("reconcileStreamedCalls", () => {
  it("accepts a match and returns the calls not streamed", () => {
    const r = reconcileStreamedCalls(
      [{ name: "a", args: '{"x":1}' }],
      [{ name: "a", arguments: { x: 1 } }, { name: "b", arguments: { y: 2 } }],
    );
    expect(r).toEqual({ ok: true, fixups: [], remaining: [{ name: "b", arguments: { y: 2 } }] });
  });

  it("adds one closing brace for a repaired reply", () => {
    const r = reconcileStreamedCalls([{ name: "a", args: '{"x":{"y":1}' }], [{ name: "a", arguments: { x: { y: 1 } } }]);
    expect(r).toEqual({ ok: true, fixups: [{ type: "tool_args", index: 0, text: "}" }], remaining: [] });
  });

  it("rejects a name mismatch", () => {
    const r = reconcileStreamedCalls([{ name: "a", args: '{"x":1}' }], [{ name: "b", arguments: { x: 1 } }]);
    expect(r.ok).toBe(false);
  });

  it("rejects an argument mismatch", () => {
    const r = reconcileStreamedCalls([{ name: "a", args: '{"x":1}' }], [{ name: "a", arguments: { x: 2 } }]);
    expect(r.ok).toBe(false);
  });

  it("rejects more streamed calls than parsed", () => {
    const r = reconcileStreamedCalls(
      [{ name: "a", args: '{"x":1}' }, { name: "b", args: "{}" }],
      [{ name: "a", arguments: { x: 1 } }],
    );
    expect(r.ok).toBe(false);
  });
});
