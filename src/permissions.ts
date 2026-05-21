import type { PermissionHandler, PermissionDecision } from "./types.js";

/** Always allow everything. Used internally when permissionMode is "bypassPermissions". */
export const AUTOPILOT: PermissionHandler = () => ({ allow: true });

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "AskUserQuestion",
]);

/** Allow read-only tools, deny anything that modifies files or runs commands. */
export const READONLY: PermissionHandler = ({ tool }) => {
  if (READ_ONLY_TOOLS.has(tool)) {
    return { allow: true };
  }
  return { allow: false, message: `Read-only mode: ${tool} is not allowed` };
};

/**
 * Wrap our simple PermissionHandler into the SDK's canUseTool callback shape.
 *
 * SDK expects: (toolName, input, options) => { behavior, updatedInput?, message? }
 * We accept: ({ tool, input, reason }) => { allow, updatedInput?, message? }
 */
export function wrapPermissionHandler(
  handler: PermissionHandler
): (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>
) => Promise<{ behavior: string; updatedInput?: Record<string, unknown>; message?: string }> {
  return async (toolName, input, options) => {
    const decision: PermissionDecision = await handler({
      tool: toolName,
      input,
      reason: (options.decisionReason as string) || undefined,
    });

    if (decision.allow) {
      return {
        behavior: "allow",
        updatedInput: decision.updatedInput || input,
      };
    }
    return {
      behavior: "deny",
      message: decision.message || "Denied by permission handler",
    };
  };
}
