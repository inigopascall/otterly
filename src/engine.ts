import { execSync, execFileSync } from "child_process";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import type {
  AgentEvent,
  AgentResult,
  EngineOptions,
  ToolExecution,
} from "./types.js";
import { normalizeEvents, createEventContext } from "./events.js";
import { classifyError, AgentError } from "./errors.js";
import { wrapPermissionHandler } from "./permissions.js";
import { Session } from "./session.js";

type QueryFn = (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;

let cachedQueryFn: QueryFn | null = null;
let resolvedMode: "sdk" | "cli" | null = null;

/**
 * Find the `claude` CLI binary. Returns the name or null.
 */
function findClaudeCLI(): string | null {
  for (const bin of ["claude", "claude-code"]) {
    try {
      execFileSync("which", [bin], { stdio: "pipe" });
      execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 5000 });
      return bin;
    } catch {
      // Try next
    }
  }
  return null;
}

/**
 * Build a shell command string for `claude -p`.
 * Escapes the prompt for safe shell embedding.
 */
function buildCLICommand(cliBin: string, prompt: string, opts: Record<string, unknown>): string {
  // Shell-escape single quotes in prompt
  const safePrompt = prompt.replace(/'/g, "'\\''");
  const parts = [cliBin, "-p", `'${safePrompt}'`, "--output-format", "stream-json", "--verbose"];

  if (opts.model) parts.push("--model", String(opts.model));
  if (opts.systemPrompt) {
    const safe = String(opts.systemPrompt).replace(/'/g, "'\\''");
    parts.push("--system-prompt", `'${safe}'`);
  }
  if (opts.resume) parts.push("--resume", String(opts.resume));
  if (opts.permissionMode) parts.push("--permission-mode", String(opts.permissionMode));
  if (opts.allowedTools) {
    for (const tool of opts.allowedTools as string[]) parts.push("--allowedTools", tool);
  }
  if (opts.disallowedTools) {
    for (const tool of opts.disallowedTools as string[]) parts.push("--disallowedTools", tool);
  }

  return parts.join(" ");
}

/**
 * Build a QueryFn that runs `claude -p` via execSync in a worker thread.
 *
 * The Bun-compiled `claude` binary doesn't pipe stdout to Node.js child_process
 * async APIs (spawn/exec), but execSync through a shell works reliably.
 * We run it in a worker thread to avoid blocking the event loop.
 */
function createCLIQueryFn(cliBin: string): QueryFn {
  return function cliQuery(args: { prompt: unknown; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>> {
    const opts = args.options || {};
    const prompt = typeof args.prompt === "string" ? args.prompt : JSON.stringify(args.prompt);
    const cmd = buildCLICommand(cliBin, prompt, opts);

    return {
      async *[Symbol.asyncIterator]() {
        // Run execSync in a worker thread to keep the event loop free
        const stdout: string = await new Promise((resolve, reject) => {
          const workerCode = `
            const { parentPort, workerData } = require('worker_threads');
            const { execSync } = require('child_process');
            try {
              const out = execSync(workerData.cmd, {
                encoding: 'utf-8',
                timeout: workerData.timeout,
                maxBuffer: 50 * 1024 * 1024,
                cwd: workerData.cwd || undefined,
                env: process.env,
              });
              parentPort.postMessage({ ok: true, data: out });
            } catch (err) {
              parentPort.postMessage({ ok: false, error: err.message });
            }
          `;

          const timeout = (opts.abortController as AbortController | undefined)
            ? 10 * 60 * 1000   // 10 min for streaming
            : 5 * 60 * 1000;   // 5 min for one-shot

          const cwd = opts.cwd ? String(opts.cwd) : undefined;

          const worker = new Worker(workerCode, {
            eval: true,
            workerData: { cmd, timeout, cwd },
          });

          worker.on("message", (msg: { ok: boolean; data?: string; error?: string }) => {
            if (msg.ok) {
              resolve(msg.data || "");
            } else {
              reject(new Error(msg.error || "CLI execution failed"));
            }
          });

          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
          });

          // Handle abort
          const ac = opts.abortController as AbortController | undefined;
          if (ac) {
            ac.signal.addEventListener("abort", () => {
              worker.terminate();
              reject(new Error("Aborted"));
            });
          }
        });

        // Parse the NDJSON output line by line and yield each event
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            yield JSON.parse(line);
          } catch {
            // Skip non-JSON lines
          }
        }
      },
    };
  };
}

async function resolveSDK(): Promise<QueryFn> {
  if (cachedQueryFn) return cachedQueryFn;

  // 1. Try the npm SDK packages
  for (const pkg of ["@anthropic-ai/claude-code", "@anthropic-ai/claude-agent-sdk"]) {
    try {
      const mod = await import(pkg);
      const fn = mod.query || mod.default?.query;
      if (typeof fn === "function") {
        cachedQueryFn = fn as QueryFn;
        resolvedMode = "sdk";
        return cachedQueryFn;
      }
    } catch {
      // Try next
    }
  }

  // 2. Fall back to the CLI binary (works regardless of install method)
  const cliBin = await findClaudeCLI();
  if (cliBin) {
    cachedQueryFn = createCLIQueryFn(cliBin);
    resolvedMode = "cli";
    return cachedQueryFn;
  }

  throw new AgentError(
    "SDK_NOT_FOUND",
    "Could not find Claude Code. Install it from https://docs.anthropic.com/en/docs/claude-code or:\n  npm install -g @anthropic-ai/claude-code"
  );
}

export class ClaudeEngine {
  private defaults: Partial<EngineOptions>;

  constructor(defaults?: Partial<EngineOptions>) {
    this.defaults = defaults || {};
  }

  private mergeOptions(options?: EngineOptions): EngineOptions {
    return { ...this.defaults, ...options };
  }

  /**
   * Run a prompt and get the final result. Blocks until complete.
   *
   * ```ts
   * const result = await claude.run("Fix the login bug", { cwd: "./app" });
   * console.log(result.text, result.cost);
   * ```
   */
  async run(prompt: string, options?: EngineOptions): Promise<AgentResult> {
    const tools: ToolExecution[] = [];
    let resultText = "";
    let cost = 0;
    let duration = 0;
    let sessionId = "";
    let usage = { input_tokens: 0, output_tokens: 0 };
    const pendingToolUses = new Map<string, { tool: string; input: Record<string, unknown> }>();

    for await (const event of this.stream(prompt, options)) {
      switch (event.type) {
        case "text":
          resultText = event.text;
          break;
        case "tool_use":
          pendingToolUses.set(event.id, { tool: event.tool, input: event.input });
          break;
        case "tool_result": {
          const pending = pendingToolUses.get(event.toolUseId);
          tools.push({
            tool: pending?.tool || event.tool,
            input: pending?.input || {},
            output: event.output,
            isError: event.isError,
          });
          pendingToolUses.delete(event.toolUseId);
          break;
        }
        case "result":
          resultText = event.text || resultText;
          cost = event.cost;
          duration = event.duration;
          sessionId = event.sessionId;
          usage = event.usage;
          break;
        case "error":
          throw event.error instanceof AgentError
            ? event.error
            : classifyError(event.error);
      }
    }

    return { text: resultText, cost, duration, sessionId, usage, tools };
  }

  /**
   * Stream events from a prompt in real-time.
   *
   * ```ts
   * for await (const event of claude.stream("Refactor auth", { cwd: "." })) {
   *   if (event.type === "text_delta") process.stdout.write(event.delta);
   *   if (event.type === "tool_use") console.log(`Using ${event.tool}...`);
   * }
   * ```
   */
  async *stream(prompt: string, options?: EngineOptions): AsyncGenerator<AgentEvent> {
    const opts = this.mergeOptions(options);
    const queryFn = await resolveSDK();

    const abortController = new AbortController();
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => abortController.abort());
    }

    const queryOptions: Record<string, unknown> = {
      abortController,
      cwd: opts.cwd || process.cwd(),
      permissionMode: opts.permissionMode || "bypassPermissions",
      includePartialMessages: true,
    };

    if (opts.model) queryOptions.model = opts.model;
    if (opts.maxTurns) queryOptions.maxTurns = opts.maxTurns;
    if (opts.allowedTools) queryOptions.allowedTools = opts.allowedTools;
    if (opts.disallowedTools) queryOptions.disallowedTools = opts.disallowedTools;
    if (opts.mcpServers) queryOptions.mcpServers = opts.mcpServers;
    if (opts.effort) queryOptions.effort = opts.effort;
    if (opts.resume) queryOptions.resume = opts.resume;
    if (opts.systemPrompt) queryOptions.systemPrompt = opts.systemPrompt;

    if (opts.onPermission) {
      queryOptions.permissionMode = "default";
      queryOptions.canUseTool = wrapPermissionHandler(opts.onPermission);
    }

    const ctx = createEventContext();

    try {
      const queryInstance = queryFn({ prompt, options: queryOptions });

      for await (const raw of queryInstance) {
        if (abortController.signal.aborted) break;

        const events = normalizeEvents(raw as Record<string, unknown>, ctx);
        for (const event of events) {
          yield event;
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || abortController.signal.aborted)
      ) {
        return;
      }
      throw classifyError(err);
    }
  }

  /**
   * Create a multi-turn session. Context persists across send() calls.
   *
   * ```ts
   * const session = claude.session({ cwd: "./my-project" });
   * await session.send("Create a REST API");
   * await session.send("Now add auth to it");
   * session.close();
   * ```
   */
  session(options?: EngineOptions): Session {
    const opts = this.mergeOptions(options);
    // Session needs the query function — resolve it lazily on first send()
    // We wrap it in a lazy resolver to avoid top-level await
    let resolvedFn: QueryFn | null = null;

    const lazyQueryFn: QueryFn = async function* (args) {
      if (!resolvedFn) {
        resolvedFn = await resolveSDK();
      }
      yield* resolvedFn(args);
    };

    return new Session(lazyQueryFn, opts);
  }
}
