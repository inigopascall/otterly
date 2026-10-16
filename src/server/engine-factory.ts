/**
 * Returns the engine every HTTP route uses. Tests replace this module to
 * script engine output.
 */
import { ClaudeEngine } from "../engine.js";

export function makeEngine(): ClaudeEngine {
  return new ClaudeEngine();
}
