// ── Configuration ──

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface EngineOptions {
  /** Working directory for file operations. Defaults to process.cwd() */
  cwd?: string;
  /** Model to use (e.g. "claude-sonnet-4-20250514") */
  model?: string;
  /** Permission mode. Defaults to "bypassPermissions" (autopilot) */
  permissionMode?: PermissionMode;
  /** Custom system prompt */
  systemPrompt?: string;
  /** Max agent turns before stopping */
  maxTurns?: number;
  /** Tool whitelist — only these tools can be used */
  allowedTools?: string[];
  /** Tool blacklist — these tools are blocked */
  disallowedTools?: string[];
  /** MCP server configurations */
  mcpServers?: Record<string, unknown>;
  /** AbortSignal to cancel the operation */
  signal?: AbortSignal;
  /** Custom permission handler. When set, permissionMode should be "default" to enable prompting */
  onPermission?: PermissionHandler;
  /** Session ID to resume a previous conversation */
  resume?: string;
  /** Reasoning effort level */
  effort?: "low" | "medium" | "high";
}

// ── Permissions ──

export interface ToolRequest {
  tool: string;
  input: Record<string, unknown>;
  reason?: string;
}

export interface PermissionDecision {
  allow: boolean;
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export type PermissionHandler = (
  request: ToolRequest
) => PermissionDecision | Promise<PermissionDecision>;

// ── Events (from stream()) ──

export interface TextEvent {
  type: "text";
  text: string;
}

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface ToolUseEvent {
  type: "tool_use";
  id: string;
  tool: string;
  input: Record<string, unknown>;
  description: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolUseId: string;
  tool: string;
  output: string;
  isError: boolean;
}

export interface SystemEvent {
  type: "system";
  sessionId: string;
  model: string;
  cwd: string;
  tools: string[];
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}

export interface ResultEvent {
  type: "result";
  text: string;
  cost: number;
  duration: number;
  sessionId: string;
  usage: { input_tokens: number; output_tokens: number };
}

export type AgentEvent =
  | TextEvent
  | TextDeltaEvent
  | ToolUseEvent
  | ToolResultEvent
  | SystemEvent
  | ErrorEvent
  | ResultEvent;

// ── Result (from run()) ──

export interface ToolExecution {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
}

export interface AgentResult {
  text: string;
  cost: number;
  duration: number;
  sessionId: string;
  usage: { input_tokens: number; output_tokens: number };
  tools: ToolExecution[];
}
