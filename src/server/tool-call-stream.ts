// Live streaming of a tool-enabled reply.
//
// The function-calling bridge (openai-compat.ts) asks the model to answer either
// in prose or with one {"tool_calls": [...]} envelope. ToolCallStreamer receives
// the reply as it is generated and decides, as early as the text allows, what
// each part of it is:
//  - prose is passed on as it arrives;
//  - in a reply that begins with the envelope, each call is announced as soon as
//    its name is known, and its arguments are passed on as they are written;
//  - anything that may be tool-call markup but cannot yet be classified is held
//    back, and is available to the caller at the end as `unsent`.
// The finished reply is still parsed by parseToolCalls / repairToolCalls, and
// that parse has the final say: reconcileStreamedCalls checks it against what
// was streamed.

import { isDeepStrictEqual } from "util";
import type { ParsedToolCall } from "./openai-compat.js";

export type StreamAction =
  | { type: "content"; text: string }
  | { type: "tool_start"; index: number; name: string; args: string }
  | { type: "tool_args"; index: number; text: string };

/**
 * - undecided: nothing passed on yet; the start of the reply is still unclear.
 * - prose: passed on as it arrives, up to any tool-call marker.
 * - envelope: the reply began with the envelope; calls are streamed.
 * - held: everything from `heldFrom` on is held back until the end.
 */
export type StreamMode = "undecided" | "prose" | "envelope" | "held";

export interface SentCall {
  name: string;
  /** The argument text sent so far. */
  args: string;
}

const TAG_MARKERS = ["<invoke", "<invoke", "<function_calls", "<function_calls"];
const ENVELOPE_KEY = '"tool_calls"';

/**
 * Whether a tool-call marker starts at s[i]: the envelope opening
 * `{ "tool_calls"` or one of Claude's native call tags. "partial" means the text
 * ends before it can be told.
 */
export function markerAt(s: string, i: number): "match" | "partial" | "none" {
  if (s[i] === "{") {
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j])) j++;
    const rest = s.slice(j, j + ENVELOPE_KEY.length);
    if (rest.length === ENVELOPE_KEY.length) return rest === ENVELOPE_KEY ? "match" : "none";
    return ENVELOPE_KEY.startsWith(rest) ? "partial" : "none";
  }
  if (s[i] === "<") {
    const rest = s.slice(i, i + 22);
    let partial = false;
    for (const tag of TAG_MARKERS) {
      if (rest.startsWith(tag)) return "match";
      if (tag.startsWith(rest)) partial = true;
    }
    return partial ? "partial" : "none";
  }
  return "none";
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** End (exclusive) of the JSON string that opens at s[i], or -1 if it is not finished. */
function stringEnd(s: string, i: number): number {
  let esc = false;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') return j + 1;
  }
  return -1;
}

/** End (exclusive) of the JSON value that starts at s[i], or -1 if it is not finished. */
function valueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (ch === '"') {
        const e = stringEnd(s, j);
        if (e < 0) return -1;
        j = e - 1;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  // A number, true, false or null ends at the next delimiter.
  let j = i;
  while (j < s.length && !/[\s,}\]]/.test(s[j])) j++;
  return j < s.length ? j : -1;
}

export interface ScannedCall {
  name?: string;
  /** Where the arguments value starts. */
  argsStart?: number;
  /** Where the arguments value ends (exclusive), once it is complete. */
  argsEnd?: number;
  /** Whether the arguments value is a JSON object. */
  argsIsObject?: boolean;
}

/**
 * Scan a possibly unfinished `{"tool_calls": [{...}, ...]}` envelope and report
 * what is known so far about each call. Stops at the first point where the text
 * ends or departs from the envelope shape.
 */
export function scanEnvelope(s: string): ScannedCall[] {
  const calls: ScannedCall[] = [];
  let i = skipWs(s, 0);
  if (s[i] !== "{") return calls;
  i = skipWs(s, i + 1);
  if (s[i] !== '"') return calls;
  const keyEnd = stringEnd(s, i);
  if (keyEnd < 0 || s.slice(i, keyEnd) !== ENVELOPE_KEY) return calls;
  i = skipWs(s, keyEnd);
  if (s[i] !== ":") return calls;
  i = skipWs(s, i + 1);
  if (s[i] !== "[") return calls;
  i = skipWs(s, i + 1);
  while (i < s.length) {
    if (s[i] !== "{") return calls;
    const call: ScannedCall = {};
    calls.push(call);
    i = skipWs(s, i + 1);
    while (i < s.length && s[i] !== "}") {
      if (s[i] !== '"') return calls;
      const kEnd = stringEnd(s, i);
      if (kEnd < 0) return calls;
      let key: unknown;
      try { key = JSON.parse(s.slice(i, kEnd)); } catch { return calls; }
      i = skipWs(s, kEnd);
      if (s[i] !== ":") return calls;
      i = skipWs(s, i + 1);
      if (i >= s.length) return calls;
      if (key === "arguments") {
        call.argsStart = i;
        call.argsIsObject = s[i] === "{";
      }
      const vEnd = valueEnd(s, i);
      if (vEnd < 0) return calls;
      if (key === "name") {
        try {
          const v: unknown = JSON.parse(s.slice(i, vEnd));
          if (typeof v === "string") call.name = v;
        } catch { /* not a string */ }
      }
      if (key === "arguments") call.argsEnd = vEnd;
      i = skipWs(s, vEnd);
      if (s[i] === ",") i = skipWs(s, i + 1);
      else if (s[i] !== "}") return calls;
    }
    if (i >= s.length) return calls;
    i = skipWs(s, i + 1);
    if (s[i] !== ",") return calls;
    i = skipWs(s, i + 1);
  }
  return calls;
}

export class ToolCallStreamer {
  private state: StreamMode = "undecided";
  private text = "";
  /** In undecided and prose mode: received text not yet passed on. */
  private pending = "";
  private heldFrom = -1;
  private envelopeFrom = -1;
  private calls: Array<SentCall & { argsTo: number }> = [];
  /** Set once a call cannot be streamed; it and every later call go out at the end. */
  private liveStopped = false;

  /** The whole reply received so far. */
  get reply(): string {
    return this.text;
  }

  /** How the reply has been classified so far. */
  get mode(): StreamMode {
    return this.state;
  }

  /** The tool calls announced so far, with the argument text sent for each. */
  get sentCalls(): SentCall[] {
    return this.calls.map(({ name, args }) => ({ name, args }));
  }

  /** Received text not passed on: held-back markup, or a tail not yet classified. Empty in envelope mode. */
  get unsent(): string {
    if (this.state === "held") return this.text.slice(this.heldFrom);
    if (this.state === "envelope") return "";
    return this.pending;
  }

  /** Take the next piece of the reply; returns what can be sent now. */
  push(delta: string): StreamAction[] {
    const out: StreamAction[] = [];
    if (!delta) return out;
    this.text += delta;
    switch (this.state) {
      case "undecided":
        this.pending += delta;
        this.decide(out);
        break;
      case "prose":
        this.pending += delta;
        this.prose(out);
        break;
      case "envelope":
        this.envelope(out);
        break;
      case "held":
        break;
    }
    return out;
  }

  private hold(from: number): void {
    this.state = "held";
    this.heldFrom = from;
    this.pending = "";
  }

  /** Classify the start of the reply. In undecided mode `pending` is the whole reply. */
  private decide(out: StreamAction[]): void {
    const lead = this.text.length - this.text.trimStart().length;
    const t = this.text.slice(lead);
    if (!t) return;
    const c = t[0];
    if (c === "{") {
      const m = markerAt(t, 0);
      if (m === "partial") return;
      if (m === "match") {
        this.state = "envelope";
        this.envelopeFrom = lead;
        this.pending = "";
        this.envelope(out);
        return;
      }
      this.hold(0); // some other JSON: parseToolCalls may still read it as a call
      return;
    }
    if (c === "[") {
      this.hold(0);
      return;
    }
    if (c === "`") {
      if (t.length < 3) {
        if ("```".startsWith(t)) return;
      } else if (t.startsWith("```")) {
        const nl = t.indexOf("\n");
        if (nl < 0) return;
        const after = t.slice(nl + 1).trimStart();
        if (!after) return;
        if (after[0] === "{" || after[0] === "[") {
          this.hold(0); // a fenced envelope
          return;
        }
      }
    }
    this.state = "prose";
    this.prose(out);
  }

  /** Pass prose on up to the first tool-call marker; hold from a marker onward. */
  private prose(out: StreamAction[]): void {
    const p = this.pending;
    const base = this.text.length - p.length;
    for (let k = 0; k < p.length; k++) {
      const ch = p[k];
      if (ch !== "{" && ch !== "<") continue;
      const m = markerAt(p, k);
      if (m === "none") continue;
      if (k > 0) out.push({ type: "content", text: p.slice(0, k) });
      if (m === "match") this.hold(base + k);
      else this.pending = p.slice(k);
      return;
    }
    if (p) out.push({ type: "content", text: p });
    this.pending = "";
  }

  /** Announce calls whose name is known and pass on their argument text. */
  private envelope(out: StreamAction[]): void {
    const env = this.text.slice(this.envelopeFrom);
    const scanned = scanEnvelope(env);
    for (let i = 0; i < scanned.length; i++) {
      const c = scanned[i];
      const sent = this.calls[i];
      if (sent) {
        const end = c.argsEnd ?? env.length;
        if (end > sent.argsTo) {
          const piece = env.slice(sent.argsTo, end);
          sent.args += piece;
          sent.argsTo = end;
          out.push({ type: "tool_args", index: i, text: piece });
        }
        continue;
      }
      if (this.liveStopped) return;
      if (c.name === undefined || c.argsStart === undefined) return;
      if (!c.argsIsObject) {
        this.liveStopped = true;
        return;
      }
      const end = c.argsEnd ?? env.length;
      const args = env.slice(c.argsStart, end);
      this.calls.push({ name: c.name, args, argsTo: end });
      out.push({ type: "tool_start", index: i, name: c.name, args });
    }
  }
}

export type Reconciled =
  | { ok: true; fixups: StreamAction[]; remaining: ParsedToolCall[] }
  | { ok: false; why: string };

/**
 * Check the calls streamed so far against the parse of the finished reply.
 *
 * Each streamed call must have the parsed call's name, and its argument text
 * must parse to the parsed arguments — or do so with one closing brace added,
 * which covers a reply repaired by repairToolCalls; that brace is returned in
 * `fixups`. `remaining` holds the parsed calls that were not streamed.
 */
export function reconcileStreamedCalls(sent: SentCall[], calls: ParsedToolCall[]): Reconciled {
  if (sent.length > calls.length) {
    return { ok: false, why: `${sent.length} calls were streamed but ${calls.length} parsed` };
  }
  const fixups: StreamAction[] = [];
  for (let i = 0; i < sent.length; i++) {
    if (sent[i].name !== calls[i].name) {
      return { ok: false, why: `call ${i} was streamed as ${sent[i].name} but parsed as ${calls[i].name}` };
    }
    let matched = false;
    for (const tail of ["", "}"]) {
      let value: unknown;
      try { value = JSON.parse(sent[i].args + tail); } catch { continue; }
      if (isDeepStrictEqual(value, calls[i].arguments)) {
        if (tail) fixups.push({ type: "tool_args", index: i, text: tail });
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { ok: false, why: `the arguments streamed for call ${i} (${calls[i].name}) differ from the parsed arguments` };
    }
  }
  return { ok: true, fixups, remaining: calls.slice(sent.length) };
}
