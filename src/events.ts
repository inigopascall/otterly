import type { AgentEvent } from "./types.js";

// Track state across messages for context (tool name lookup, session id, accumulated text)
export interface EventContext {
  sessionId: string | null;
  toolNames: Map<string, string>; // toolUseId → toolName
  accumulatedText: string;
}

export function createEventContext(): EventContext {
  return {
    sessionId: null,
    toolNames: new Map(),
    accumulatedText: "",
  };
}

/**
 * Normalize a raw SDK message into clean AgentEvent(s).
 * Returns an array because one SDK message can contain multiple content blocks.
 */
export function normalizeEvents(
  raw: Record<string, unknown>,
  ctx: EventContext
): AgentEvent[] {
  const type = raw.type as string;
  const events: AgentEvent[] = [];

  switch (type) {
    case "system": {
      if (raw.subtype === "init") {
        const sessionId = raw.session_id as string;
        ctx.sessionId = sessionId;
        events.push({
          type: "system",
          sessionId,
          model: (raw.model as string) || "",
          cwd: (raw.cwd as string) || "",
          tools: (raw.tools as string[]) || [],
        });
      }
      break;
    }

    case "assistant": {
      const message = raw.message as Record<string, unknown> | undefined;
      const content = (message?.content || []) as Array<Record<string, unknown>>;

      for (const block of content) {
        if (block.type === "text") {
          events.push({
            type: "text",
            text: block.text as string,
          });
        } else if (block.type === "tool_use") {
          const id = block.id as string;
          const name = block.name as string;
          const input = (block.input || {}) as Record<string, unknown>;
          ctx.toolNames.set(id, name);
          events.push({
            type: "tool_use",
            id,
            tool: name,
            input,
            description: describeToolUse(name, input),
          });
        }
      }
      break;
    }

    case "user": {
      if (raw.tool_use_result !== undefined) {
        const message = raw.message as Record<string, unknown> | undefined;
        const content = (message?.content || []) as Array<Record<string, unknown>>;

        for (const block of content) {
          if (block.type === "tool_result") {
            const toolUseId = block.tool_use_id as string;
            events.push({
              type: "tool_result",
              toolUseId,
              tool: ctx.toolNames.get(toolUseId) || "unknown",
              output: extractToolResultText(block.content),
              isError: (block.is_error as boolean) || false,
            });
          }
        }
      }
      break;
    }

    case "stream_event": {
      const event = raw.event as Record<string, unknown> | undefined;
      if (!event) break;

      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta") {
          const text = delta.text as string;
          ctx.accumulatedText += text;
          events.push({
            type: "text_delta",
            delta: text,
          });
        }
      }
      break;
    }

    case "result": {
      if (raw.subtype === "success") {
        events.push({
          type: "result",
          text: (raw.result as string) || "",
          cost: (raw.total_cost_usd as number) || 0,
          duration: (raw.duration_ms as number) || 0,
          sessionId: ctx.sessionId || "",
          usage: (raw.usage as { input_tokens: number; output_tokens: number }) || {
            input_tokens: 0,
            output_tokens: 0,
          },
        });
      } else {
        const errors = raw.errors as string[] | undefined;
        const msg = errors ? errors.join("\n") : `Stopped: ${raw.subtype}`;
        events.push({
          type: "error",
          error: new Error(msg),
        });
      }
      break;
    }
  }

  return events;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

export function describeToolUse(
  name: string,
  input: Record<string, unknown>
): string {
  switch (name) {
    case "Read":
      return `Reading file: ${input.file_path || "unknown"}`;
    case "Write":
      return `Writing file: ${input.file_path || "unknown"}`;
    case "Edit":
      return `Editing file: ${input.file_path || "unknown"}`;
    case "MultiEdit":
      return `Editing file: ${input.file_path || "unknown"}`;
    case "Bash":
      return `Running command: ${truncate(String(input.command || ""), 80)}`;
    case "Glob":
      return `Searching for files: ${input.pattern || ""}`;
    case "Grep":
      return `Searching content: ${truncate(String(input.pattern || ""), 60)}`;
    case "WebFetch":
      return `Fetching: ${input.url || ""}`;
    case "WebSearch":
      return `Searching: ${input.query || ""}`;
    case "Task":
      return `Running sub-task: ${input.description || ""}`;
    case "NotebookEdit":
      return `Editing notebook: ${input.notebook_path || "unknown"}`;
    default:
      return `Using tool: ${name}`;
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (typeof c === "object" && c !== null && "type" in c) {
          const obj = c as Record<string, unknown>;
          if (obj.type === "text") return obj.text as string;
        }
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}
