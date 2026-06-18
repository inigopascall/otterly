/**
 * Returns a ClaudeEngine or CursorEngine depending on the process-wide backend
 * selection.  Both engines expose identical run()/stream() signatures so
 * call sites can use the result interchangeably.
 */
import { ClaudeEngine } from "../engine.js";
import { CursorEngine } from "../cursor-engine.js";
import { getBackend } from "./models.js";

export function makeEngine(): ClaudeEngine | CursorEngine {
  return getBackend() === "cursor" ? new CursorEngine() : new ClaudeEngine();
}
