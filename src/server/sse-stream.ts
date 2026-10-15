// One streamed OpenAI chat completion: the SSE chunks that a client such as
// AiderDesk reads as reasoning (`reasoning_content`), reply text (`content`)
// and tool calls (`tool_calls`), ending with a chunk that carries
// finish_reason and usage.

import type { ServerResponse } from "http";
import crypto from "crypto";
import { makeStreamChunk, sseData, type OpenAIStreamDelta, type OpenAIUsage } from "./openai-compat.js";
import { traceAppend } from "./trace.js";

/** A keepalive comment is sent after this long without any other write. */
export const KEEPALIVE_MS = 5000;

/** Write to an SSE response with backpressure support. */
export async function sseWrite(res: ServerResponse, data: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return;
  const ok = res.write(data);
  if (!ok) {
    // Wait for the socket to drain, but stop waiting if it closes first: a
    // client that has gone away never drains, and the request would hang.
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });
  }
}

export class SseStream {
  readonly id = `chatcmpl-otterly-${crypto.randomUUID().slice(0, 12)}`;
  /** Reply text sent so far. */
  sentText = "";
  /** Reasoning text sent so far. */
  sentReasoning = "";
  private lastWriteAt = Date.now();
  private readonly openedAt = Date.now();
  private readonly keepalive: NodeJS.Timeout;

  /** Sends the response headers at once. `traceId` names the request's trace directory, for sse-out.tsv. */
  constructor(readonly response: ServerResponse, private readonly model: string, private readonly traceId = "") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    this.keepalive = setInterval(() => {
      if (Date.now() - this.lastWriteAt < KEEPALIVE_MS) return;
      if (response.writableEnded || response.destroyed) return;
      try {
        response.write(": keepalive\n\n");
        this.lastWriteAt = Date.now();
      } catch { /* ignore */ }
    }, 1000);
    this.keepalive.unref?.();
  }

  /** One row in sse-out.tsv: ms since the stream opened, kind, bytes. */
  private record(kind: string, bytes: number): void {
    traceAppend(this.traceId, "sse-out.tsv", `${Date.now() - this.openedAt}\t${kind}\t${bytes}`);
  }

  private async send(delta: OpenAIStreamDelta, finishReason: string | null = null, usage?: OpenAIUsage): Promise<void> {
    this.lastWriteAt = Date.now();
    const data = sseData(makeStreamChunk(this.id, delta, finishReason, this.model, usage));
    const kind = finishReason ? `finish:${finishReason}`
      : delta.reasoning_content !== undefined ? "reasoning"
      : delta.content !== undefined ? "content"
      : delta.tool_calls ? (delta.tool_calls[0]?.function?.name ? "tool_start" : "tool_args")
      : delta.role ? "start"
      : "other";
    this.record(kind, Buffer.byteLength(data));
    await sseWrite(this.response, data);
  }

  /** The opening chunk, carrying the role. */
  async start(): Promise<void> {
    await this.send({ role: "assistant" });
  }

  async thinking(text: string): Promise<void> {
    if (!text) return;
    this.sentReasoning += text;
    await this.send({ reasoning_content: text });
  }

  async text(text: string): Promise<void> {
    if (!text) return;
    this.sentText += text;
    await this.send({ content: text });
  }

  /** Announce a tool call. `args` is the start of its arguments, possibly empty. */
  async toolStart(index: number, id: string, name: string, args: string): Promise<void> {
    await this.send({ tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] });
  }

  /** More of an announced tool call's arguments. */
  async toolArgs(index: number, text: string): Promise<void> {
    if (!text) return;
    await this.send({ tool_calls: [{ index, function: { arguments: text } }] });
  }

  /** The final chunk, then `[DONE]`. */
  async finish(reason: "stop" | "tool_calls", usage?: OpenAIUsage): Promise<void> {
    await this.send({}, reason, usage);
    await this.done();
  }

  /** An in-stream error, then `[DONE]`. Clients stop on it; they do not retry. */
  async fail(message: string, type: string, code: number): Promise<void> {
    const data = sseData({ error: { message, type, code } });
    this.record(`error:${code}`, Buffer.byteLength(data));
    await sseWrite(this.response, data);
    await this.done();
  }

  /** `[DONE]`, then end the response. */
  async done(): Promise<void> {
    this.close();
    await sseWrite(this.response, "data: [DONE]\n\n");
    if (!this.response.writableEnded && !this.response.destroyed) this.response.end();
  }

  /**
   * Cut the connection without ending the response. Clients on the AI SDK treat
   * this as a network failure: they discard the partial reply and re-send the
   * request.
   */
  drop(): void {
    this.close();
    this.record("drop", 0);
    (this.response as ServerResponse & { otterlyDropped?: boolean }).otterlyDropped = true;
    this.response.destroy();
  }

  /** Stop the keepalive. */
  close(): void {
    clearInterval(this.keepalive);
  }
}
