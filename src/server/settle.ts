// Guarantees every HTTP request ends with a response.
//
// A route handler that returns without writing (an abort, a swallowed error)
// would otherwise leave the client waiting on an open socket indefinitely.
// index.ts calls settleResponse once the handler has returned.

import type { ServerResponse } from "http";
import { openaiErrorBody, sseData } from "./openai-compat.js";

export type RequestOutcome = "ok" | "timeout" | "client_disconnected" | "error";

/**
 * End `res` if the handler left it open, and classify how the request ended.
 *
 * - Socket already gone: nothing can be written; "client_disconnected".
 * - Nothing written yet: a 504 (timed out) or 500 error body.
 * - SSE stream left open: an error chunk and `[DONE]`, then end.
 *
 * `sse` says whether the response is an SSE stream. The caller must say so:
 * the routes set Content-Type through writeHead, and getHeader cannot see
 * headers set that way.
 */
export function settleResponse(res: ServerResponse, timedOut: boolean, isOpenai: boolean, sse = false): RequestOutcome {
  if (!res.writableEnded) {
    if (res.destroyed) return "client_disconnected";
    const status = timedOut ? 504 : 500;
    const message = timedOut
      ? "No response from the model within the time limit."
      : "The request ended without a response.";
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(isOpenai ? openaiErrorBody(status, message) : { error: message }));
    } else {
      if (sse) {
        res.write(sseData({ error: { message, type: timedOut ? "timeout_error" : "server_error", code: status } }));
        res.write("data: [DONE]\n\n");
      }
      res.end();
    }
    return timedOut ? "timeout" : "error";
  }
  if (timedOut || res.statusCode === 504) return "timeout";
  return res.statusCode >= 400 ? "error" : "ok";
}
