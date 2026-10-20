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
  /** Tools that run without asking for permission, in Claude Code's
   *  permission-rule syntax (e.g. "Bash(git log *)"). To choose which tools
   *  exist at all, use `tools`. */
  allowedTools?: string[];
  /** Deny rules. A bare tool name removes that tool. */
  disallowedTools?: string[];
  /** Built-in Claude Code tools the model may use, as for `claude --tools`:
   *  names such as ["Read", "Grep"], or ["default"] for Claude Code's default
   *  set. Unset or empty: no tools at all. */
  tools?: string[];
  /** MCP servers to load, in Claude Code's `mcpServers` format. Setting any
   *  runs the CLI without --safe-mode, which would stop them loading. */
  mcpServers?: Record<string, unknown>;
  /** AbortSignal to cancel the operation */
  signal?: AbortSignal;
  /** Called before each tool use that needs approval; read-only tools such as
   *  Read may run without asking. Setting it sets permissionMode to "default". */
  onPermission?: PermissionHandler;
  /** Session ID to resume a previous conversation */
  resume?: string;
  /** Reasoning effort level */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** When true, client tools are external OpenAI tools: Claude rejects native
   *  tool inventory/activity on this path. */
  clientToolCalls?: boolean;
  /** Only the OpenAI HTTP route opts in: preserve structured CLI 429 across engine cleanup. */
  structured429ForOpenAI?: boolean;
  /** Correlation id for logging and file tracing. Set from the HTTP request id
   *  so engine-level log lines line up with the request that produced them. */
  traceId?: string;
  /** Server-side deadline for the run, in ms. The Claude CLI's own hard timer
   *  is set CLI_BACKSTOP_MS beyond it. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Stop the run after this long with no output from the Claude CLI, in ms.
   *  Defaults to the server's --idle-timeout (DEFAULT_IDLE_TIMEOUT_MS). */
  idleTimeoutMs?: number;
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

/** A piece of the model's (summarised) thinking, as it streams. */
export interface ThinkingDeltaEvent {
  type: "thinking_delta";
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
  | ThinkingDeltaEvent
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
