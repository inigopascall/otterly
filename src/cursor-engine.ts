/**
 * cursor-engine.ts
 *
 * CursorEngine — mirrors ClaudeEngine's run()/stream() public interface but
 * drives the `cursor-agent` CLI instead of the Anthropic Claude CLI.
 *
 * Design notes:
 *  - spawnWithAbort() buffers the full stdout before resolving (same as the
 *    Claude CLI path in engine.ts).  stream() therefore yields all events
 *    after process exit, not incrementally.  This is behaviourally identical
 *    to the existing Claude CLI mode and is acceptable for the two-process
 *    design.
 *  - session() is intentionally omitted: the Session abstraction is
 *    hard-coupled to the Claude SDK QueryFn/normalizeEvents protocol and is
 *    out of scope for the Cursor backend.
 */

import { execFileSync } from "child_process";
import { spawnWithAbort } from "./engine.js";
import { normalizeCursorEvent, createCursorParseState } from "./cursor-events.js";
import type { AgentEvent, AgentResult, EngineOptions, ToolExecution } from "./types.js";
import { classifyError, AgentError } from "./errors.js";

// ---------------------------------------------------------------------------
// CLI discovery
// ---------------------------------------------------------------------------

/** Cached path to the cursor-agent binary, or null if not found. */
let cachedCursorBin: string | null = null;

/**
 * Attempts to locate the `cursor-agent` binary on the current PATH.
 * Uses `cursor-agent --version` (5 s timeout) to confirm it is functional.
 * Caches the result so discovery only runs once per process lifetime.
 * Returns `"cursor-agent"` on success or `null` when unavailable.
 */
function findCursorCLI(): string | null {
  if (cachedCursorBin !== null) return cachedCursorBin;
  try {
    execFileSync("cursor-agent", ["--version"], { timeout: 5000, stdio: "pipe" });
    cachedCursorBin = "cursor-agent";
    return cachedCursorBin;
  } catch {
    cachedCursorBin = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

/**
 * Builds the argv array used to invoke cursor-agent directly (no shell).
 *
 * Returning an array rather than a shell string means:
 *  - No shell quoting is required — workspace paths with spaces or special
 *    characters are passed verbatim as a single argv element.
 *  - There is no /bin/sh dependency, so the command works in minimal
 *    container environments where a shell may not be present.
 *
 * The user prompt is fed via stdin (not as an argv argument) to avoid
 * E2BIG errors on large inputs — the same approach used by ClaudeEngine.
 *
 * Flags:
 *  -p                        non-interactive / pipe mode
 *  --output-format stream-json  NDJSON event stream on stdout
 *  --stream-partial-output   emit delta events as text is generated
 *  --mode ask                read-only posture; no file edits permitted
 *  --trust                   suppresses the interactive trust prompt
 *  --workspace <cwd>         working directory for the invocation
 *  --model <model>           (optional) model override
 *
 * Q1: Consider adding "--sandbox enabled" once read-confinement semantics
 *     are verified against the cursor-agent sandboxing implementation.
 */
function buildCursorCommand(cliBin: string, opts: EngineOptions): string[] {
  const cwd = opts.cwd ? String(opts.cwd) : process.cwd();
  const parts: string[] = [
    cliBin,
    "-p",
    "--output-format", "stream-json",
    "--stream-partial-output",
    "--mode", "ask",
    "--trust",
    "--workspace", cwd,
  ];

  // Append optional model override.
  if (opts.model) {
    parts.push("--model", opts.model);
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Assembles the full stdin payload that cursor-agent receives.
 *
 * Because cursor-agent has no dedicated `--system-prompt` flag, any system
 * prompt is injected as a prefix inside the user turn, followed by a
 * hard read-only directive, then the actual user request.
 *
 * The directive is placed first so it is never buried by a long system prompt.
 */
function buildCursorPrompt(userPrompt: string, systemPrompt?: string): string {
  // Instructional directive that enforces read-only reasoning (AGENTS.md §C).
  const directive =
    "You must NOT read, search, open, or edit any files, and must NOT run " +
    "shell commands. Reason ONLY over the information provided in this " +
    "message and return your answer directly.";

  const parts: string[] = [directive];

  if (systemPrompt) {
    parts.push("");
    parts.push(systemPrompt);
  }

  parts.push("");
  parts.push("=== USER REQUEST ===");
  parts.push(userPrompt);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CursorEngine
// ---------------------------------------------------------------------------

/**
 * Drives the `cursor-agent` CLI with the same run()/stream() interface
 * as ClaudeEngine.  Instantiate once and reuse across requests.
 */
export class CursorEngine {
  private defaults: Partial<EngineOptions>;

  constructor(defaults?: Partial<EngineOptions>) {
    this.defaults = defaults || {};
  }

  /** Merges constructor-level defaults with per-call options. */
  private mergeOptions(options?: EngineOptions): EngineOptions {
    return { ...this.defaults, ...options };
  }

  /**
   * Streams AgentEvents produced by a single cursor-agent invocation.
   *
   * Internally calls spawnWithAbort() which buffers full stdout, then splits
   * the buffered NDJSON into lines and yields events.  All events are yielded
   * after the subprocess exits (not incrementally), which is consistent with
   * the existing Claude CLI streaming behaviour.
   */
  async *stream(prompt: string, options?: EngineOptions): AsyncGenerator<AgentEvent> {
    const opts = this.mergeOptions(options);

    // Locate the cursor-agent binary.
    const cliBin = findCursorCLI();
    if (cliBin === null) {
      throw new AgentError(
        "SDK_NOT_FOUND",
        "Could not find cursor-agent. Install Cursor CLI and run 'cursor-agent login'.",
      );
    }

    const cmd   = buildCursorCommand(cliBin, opts);
    const input = buildCursorPrompt(prompt, opts.systemPrompt);

    // Bridge an external AbortSignal into a local AbortController so we can
    // also trigger abort internally on timeout (mirrors ClaudeEngine pattern).
    const abortController = new AbortController();
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    // Use a longer timeout when the caller provides its own signal; the caller
    // is expected to cancel via that signal if it needs a shorter deadline.
    const timeoutMs = opts.signal ? 10 * 60 * 1000 : 5 * 60 * 1000;

    let stdout: string;
    try {
      stdout = await spawnWithAbort(cmd, {
        cwd: opts.cwd ? String(opts.cwd) : undefined,
        abortController,
        timeoutMs,
        input,
      });
    } catch (err: unknown) {
      // If the abort was triggered by our own signal, exit silently.
      if (
        abortController.signal.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return;
      }
      throw classifyError(err);
    }

    // Parse the NDJSON output and yield normalised AgentEvents.
    const state = createCursorParseState();
    for (const line of stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Skip malformed lines.
      }
      for (const ev of normalizeCursorEvent(obj, state)) {
        yield ev;
      }
    }
  }

  /**
   * Runs a prompt to completion and returns an AgentResult.
   *
   * Aggregates the stream produced by stream(), collecting text content,
   * tool executions, and result metadata into a single resolved value.
   */
  async run(prompt: string, options?: EngineOptions): Promise<AgentResult> {
    let text = "";
    let cost = 0;
    let duration = 0;
    let sessionId = "";
    let usage: AgentResult["usage"] = { input_tokens: 0, output_tokens: 0 };

    // Accumulates paired tool_use / tool_result events into ToolExecution records.
    const pendingToolUses = new Map<string, { tool: string; input: Record<string, unknown>; description: string }>();
    const tools: ToolExecution[] = [];

    for await (const event of this.stream(prompt, options)) {
      switch (event.type) {
        case "text":
          text += event.text;
          break;

        case "text_delta":
          text += event.delta;
          break;

        case "tool_use":
          // Stash the tool invocation; paired with tool_result below.
          pendingToolUses.set(event.id, {
            tool: event.tool,
            input: event.input,
            description: event.description ?? "",
          });
          break;

        case "tool_result": {
          // Match the result back to its originating tool_use.
          const pending = pendingToolUses.get(event.toolUseId);
          tools.push({
            tool: event.tool,
            input: pending?.input ?? {},
            output: event.output,
            isError: event.isError,
          });
          pendingToolUses.delete(event.toolUseId);
          break;
        }

        case "result":
          // The result event may carry additional text in its own field.
          if (event.text) text = event.text || text;
          cost      = event.cost;
          duration  = event.duration;
          sessionId = event.sessionId;
          usage     = event.usage;
          break;

        case "error":
          throw classifyError(event.error);
      }
    }

    return {
      text,
      cost,
      duration,
      sessionId,
      usage,
      tools,
    };
  }
}
