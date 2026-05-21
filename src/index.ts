export { ClaudeEngine } from "./engine.js";
export { Session } from "./session.js";
export { AUTOPILOT, READONLY } from "./permissions.js";
export { AgentError, classifyError } from "./errors.js";
export type { ErrorCode } from "./errors.js";
export { describeToolUse } from "./events.js";

export type {
  EngineOptions,
  PermissionMode,
  ToolRequest,
  PermissionDecision,
  PermissionHandler,
  TextEvent,
  TextDeltaEvent,
  ToolUseEvent,
  ToolResultEvent,
  SystemEvent,
  ErrorEvent,
  ResultEvent,
  AgentEvent,
  ToolExecution,
  AgentResult,
} from "./types.js";

// Server exports
export { startApiServer } from "./server/index.js";
export type { ApiServerOptions, ApiServerHandle } from "./server/index.js";

import { ClaudeEngine } from "./engine.js";

/** Pre-instantiated default engine. Import and use directly. */
export const claude = new ClaudeEngine();
