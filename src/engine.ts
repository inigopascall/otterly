import { execFileSync, spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
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
import { log, logDiag } from "./server/logger.js";
import { traceWrite, traceAppend, traceAppendRaw } from "./server/trace.js";
import { quota } from "./server/quota.js";

/**
 * Runs one conversation and yields the CLI's stream-json messages, parsed.
 * `prompt` is a string (one turn) or an async iterable of stream-json user
 * messages (a multi-turn Session). `options` holds the keys ClaudeEngine and
 * Session set; buildCLICommand and createCLIQueryFn read them.
 */
export type QueryFn = (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;

let cachedQueryFn: QueryFn | null = null;

/**
 * Make every ClaudeEngine and Session that was not given its own query
 * function use `fn` in place of the claude CLI. For tests; null undoes it.
 */
export function setQueryFnForTests(fn: QueryFn | null): void {
  cachedQueryFn = fn;
}

/** The claude CLI found on PATH. */
export interface ClaudeCLIInfo {
  /** Absolute path of the executable. */
  path: string;
  /** What `claude --version` printed, e.g. "2.1.296 (Claude Code)". */
  version: string;
}

let cachedCLIInfo: ClaudeCLIInfo | null | undefined;

/** The claude CLI version the CLI suite (tests-cli/) last passed against.
 *  Update it whenever that suite passes on a newer version. */
export const TESTED_CLAUDE_CLI_VERSION = "2.1.296";

/** Shown when no claude CLI is on PATH. */
export const CLI_NOT_FOUND_MESSAGE =
  "Could not find the Claude Code CLI (`claude`) on PATH. Install it (npm install -g @anthropic-ai/claude-code) and sign in by running `claude` once.";

/**
 * Find the `claude` CLI on PATH. Returns null when there is none. The answer
 * is cached for the life of the process.
 */
export function findClaudeCLI(): ClaudeCLIInfo | null {
  // Set by the test configuration so that no test ever spawns a real `claude`
  // binary, whatever is on PATH; tests inject a query function instead.
  if (process.env.OTTERLY_DISABLE_CLAUDE_CLI === "1") return null;
  if (cachedCLIInfo !== undefined) return cachedCLIInfo;
  cachedCLIInfo = null;
  for (const bin of ["claude", "claude-code"]) {
    try {
      const path = execFileSync("which", [bin], { stdio: "pipe" }).toString().trim();
      const version = execFileSync(path, ["--version"], { stdio: "pipe", timeout: 5000 }).toString().trim();
      cachedCLIInfo = { path, version };
      break;
    } catch {
      // Try next
    }
  }
  return cachedCLIInfo;
}

/** The x.y.z at the start of a `claude --version` string, or "". */
export function cliSemver(version: string): string {
  const m = /\d+\.\d+\.\d+/.exec(version);
  return m ? m[0] : "";
}

/**
 * Build the argv for one `claude -p` run. The conversation itself is written
 * to the CLI's stdin as stream-json messages (see createCLIQueryFn), never
 * placed on the command line, so large prompts cannot hit ARG_MAX (E2BIG).
 *
 * The run is isolated unless the caller opts out: no built-in tools, no MCP
 * servers, and no settings, CLAUDE.md, hooks, plugins, skills or auto memory.
 * `tools` and `mcpServers` opt in.
 */
export function buildCLICommand(cliBin: string, opts: Record<string, unknown>): string[] {
  const parts = [cliBin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];

  // Stream the run as it happens: the model's thinking (as readable summaries)
  // and its reply arrive as stream_event lines while they are generated, not
  // in one block at the end. A healthy run therefore never goes quiet for
  // long, which the idle limit relies on.
  parts.push("--include-partial-messages", "--thinking-display", "summarized");

  if (opts.model) parts.push("--model", String(opts.model));
  if (opts.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(String(opts.effort))) {
      throw new Error(`effort must be one of ${EFFORT_LEVELS.join(", ")}`);
    }
    parts.push("--effort", String(opts.effort));
  }

  // Always override Claude Code's default system prompt. Per `claude --help`,
  // the auto-injected "dynamic" sections (cwd, env info, memory paths, git
  // status) live in the *default* system prompt and are dropped when a custom
  // --system-prompt is supplied. Honour the caller's system prompt when present;
  // otherwise fall back to a minimal neutral one so the model behaves like a
  // plain text-in/text-out chat API rather than an agentic coding assistant.
  parts.push("--system-prompt", opts.systemPrompt ? String(opts.systemPrompt) : "You are a helpful assistant.");

  // Do not load user/project/local settings or CLAUDE.md project memory, so the
  // model has no repo-specific context the caller did not explicitly send.
  parts.push("--setting-sources", "");

  // Built-in tools: only those the caller names. An empty value disables the
  // whole built-in set, so a tool added in a later Claude Code release is
  // excluded too. Tool orchestration is then left to the OpenAI-compatible
  // client, so every tool call is visible to and controlled by that client.
  const tools = Array.isArray(opts.tools) ? opts.tools.map(String).filter((t) => t !== "") : [];
  parts.push("--tools", tools.join(","));

  // MCP servers: only the caller's. --safe-mode also stops plugins, hooks,
  // skills and auto memory from loading, but it stops servers named in
  // --mcp-config as well, so it is left off when the caller supplies some.
  const mcp = opts.mcpServers && typeof opts.mcpServers === "object" && Object.keys(opts.mcpServers).length > 0
    ? opts.mcpServers as Record<string, unknown>
    : null;
  if (mcp) {
    parts.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: mcp }));
  } else {
    parts.push("--safe-mode", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }));
  }

  // With no tools and no MCP servers asked for, also deny every tool by rule,
  // whatever its source.
  if (tools.length === 0 && !mcp) parts.push("--disallowedTools", "*");

  if (opts.maxTurns !== undefined) {
    if (typeof opts.maxTurns !== "number" || !Number.isSafeInteger(opts.maxTurns) || opts.maxTurns <= 0) {
      throw new Error("maxTurns must be a positive safe integer");
    }
    parts.push("--max-turns", String(opts.maxTurns));
  }
  if (opts.resume) parts.push("--resume", String(opts.resume));
  if (opts.permissionMode) parts.push("--permission-mode", String(opts.permissionMode));
  // A permission handler answers the CLI's can_use_tool requests over stdio.
  if (typeof opts.canUseTool === "function") parts.push("--permission-prompt-tool", "stdio");
  if (opts.allowedTools) {
    for (const tool of opts.allowedTools as string[]) parts.push("--allowedTools", tool);
  }
  if (opts.disallowedTools) {
    for (const tool of opts.disallowedTools as string[]) parts.push("--disallowedTools", tool);
  }

  return parts;
}

/** Render an argv array as one shell-quoted line, for logs and traces. */
export function formatCommand(argv: string[]): string {
  return argv
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"))
    .join(" ");
}

/** Default server-side hard cap for one Claude run, in ms. A backstop: a run
 *  that has stopped producing output is caught much sooner by the idle limit. */
export const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/** Default limit on silence from the Claude CLI, in ms. The CLI prints the
 *  model's thinking and its reply as they are generated, so five minutes with
 *  no stdout at all means the run has stopped making progress. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** How often a running Claude request reports its progress on the console. */
export const PROGRESS_INTERVAL_MS = 30 * 1000;

/** Effort levels the Claude CLI accepts for --effort. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

let configuredIdleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

/** Set the silence limit for every Claude CLI run in this process. */
export function setIdleTimeoutMs(ms: number | undefined): void {
  configuredIdleTimeoutMs = typeof ms === "number" && ms > 0 ? ms : DEFAULT_IDLE_TIMEOUT_MS;
}

/** The silence limit in force for Claude CLI runs, in ms. */
export function getIdleTimeoutMs(): number {
  return configuredIdleTimeoutMs;
}

/** How far past the server deadline the CLI's own hard timer is set. The
 * server's timer must fire first so the client is told about the timeout;
 * this one only stops a child that nothing is waiting for. */
export const CLI_BACKSTOP_MS = 60 * 1000;

/** Why a CLI child was stopped before it finished on its own. */
export type CliTerminationReason = "aborted" | "timeout" | "idle" | "killed";

/**
 * Rejection from spawnWithAbort when the child did not exit by itself. Carries
 * whatever the child had printed, so the evidence survives the kill.
 */
export class CliTerminatedError extends Error {
  reason: CliTerminationReason;
  stdout: string;
  stderr: string;
  elapsedMs: number;

  constructor(
    reason: CliTerminationReason,
    message: string,
    detail: { stdout: string; stderr: string; elapsedMs: number },
  ) {
    super(message);
    this.name = "CliTerminatedError";
    this.reason = reason;
    this.stdout = detail.stdout;
    this.stderr = detail.stderr;
    this.elapsedMs = detail.elapsedMs;
  }
}

export class CliUsageLimitError extends AgentError {
  constructor(text: string) {
    super("RATE_LIMITED", `Claude API error 429: ${text}`);
  }
}

/** Every child spawned by spawnWithAbort that has not exited yet. */
const liveChildren = new Set<ChildProcess>();

/**
 * Signal every live child's process group. Children are spawned detached, so a
 * Ctrl+C in the server's terminal never reaches them; the server calls this on
 * shutdown so they do not outlive it. Returns how many were signalled.
 */
export function killAllChildren(signal: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const child of liveChildren) {
    const pid = child.pid;
    if (!pid) continue;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-pid, signal);
      n++;
    } catch {
      // Already gone.
    }
  }
  return n;
}

/**
 * Spawn a shell command and return its stdout. Cancellable via AbortController.
 *
 * Hard rule: the returned promise must not resolve or reject until the child
 * process has actually exited. The whole point is that the upstream request
 * queue uses the promise lifecycle to track a worker slot — if we return early
 * while the child is still alive, the slot leaks and we end up with a stuck
 * queue (see https://github.com/ReallyArtificial/otterly/issues/4).
 *
 * On abort or timeout:
 *   1. Send SIGTERM to the child's process group.
 *   2. Wait `killGraceMs` for it to exit cleanly.
 *   3. If still alive, send SIGKILL to the group.
 *   4. Resolve only when the child's `exit` event fires.
 *
 * Spawned with `detached: true` so it owns its own process group — a Bun-
 * compiled binary that re-execs or spawns helpers can be reaped in one shot
 * via the negative-PID kill (`process.kill(-pid, signal)`).
 *
 * `cmd` is either an argv array, spawned directly, or a command string, run
 * through a shell. buildCLICommand returns an argv array.
 *
 * Input (if any) is written to the child's stdin via the `input` option rather
 * than being placed on the command line, so that large prompts do not exceed
 * the OS ARG_MAX limit (E2BIG).
 */
export interface SpawnWithAbortOptions {
  cwd?: string;
  abortController?: AbortController;
  /** Hard timeout in ms. Triggers the same kill ladder as abort. Unset: no limit. */
  timeoutMs?: number;
  /** Stop the child after this long with no stdout, in ms. Unset: no limit. */
  idleTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. Default 5s. */
  killGraceMs?: number;
  /** Data for the child's stdin. A string is written whole and stdin is then
   *  closed. An async iterable is written chunk by chunk as it yields, and
   *  stdin is closed when it ends. */
  input?: string | AsyncIterable<string>;
  /** Asked when the idle limit is reached. Returning true restarts the limit
   *  instead of stopping the child, which is waiting for input, not stalled. */
  idleExempt?: () => boolean;
  /** Called with each stdout chunk as it arrives. */
  onStdout?: (chunk: Buffer) => void;
  /** Called with each stderr chunk as it arrives. */
  onStderr?: (chunk: Buffer) => void;
  /** Test-only injection hook. */
  spawnFn?: typeof spawn;
}

export function spawnWithAbort(cmd: string | string[], opts: SpawnWithAbortOptions): Promise<string> {
  const killGraceMs = opts.killGraceMs ?? 5000;
  const doSpawn = opts.spawnFn ?? spawn;

  return new Promise<string>((resolve, reject) => {
    // When cmd is an array, use the first element as the executable and the
    // rest as argv — no shell involved, so no quoting is needed and there is
    // no /bin/sh dependency.  When cmd is a plain string, run it through a
    // shell.
    const child = doSpawn(
      Array.isArray(cmd) ? cmd[0] : cmd,
      Array.isArray(cmd) ? cmd.slice(1) : [],
      {
        shell: !Array.isArray(cmd),  // shell only for string form
        cwd: opts.cwd,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: [opts.input != null ? "pipe" : "ignore", "pipe", "pipe"],
      }
    );

    const startedAt = Date.now();
    liveChildren.add(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => {
      armIdle();
      stdoutChunks.push(c);
      try { opts.onStdout?.(c); } catch { /* observers must not break the run */ }
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderrChunks.push(c);
      try { opts.onStderr?.(c); } catch { /* observers must not break the run */ }
    });

    let aborted = false;
    let timedOut = false;
    let idledOut = false;
    let killing = false;
    let sigkillTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    const killGroup = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (!pid) return;
      try {
        if (process.platform === "win32") {
          // No process groups on Windows; kill the child directly.
          child.kill(signal);
        } else {
          // Negative PID = whole process group (works because detached: true).
          process.kill(-pid, signal);
        }
      } catch {
        // Already gone — that is what we wanted.
      }
    };

    // The first reason to stop the child wins; later ones change nothing.
    const beginKillLadder = () => {
      if (killing) return;
      killing = true;
      killGroup("SIGTERM");
      sigkillTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    };

    const hardTimer = opts.timeoutMs !== undefined
      ? setTimeout(() => {
          if (killing) return;
          timedOut = true;
          beginKillLadder();
        }, opts.timeoutMs)
      : null;

    // Restarted by every stdout chunk: the child is stopped only after
    // idleTimeoutMs with no output at all.
    const armIdle = () => {
      if (!opts.idleTimeoutMs || killing) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (killing) return;
        if (opts.idleExempt?.()) {
          armIdle();
          return;
        }
        idledOut = true;
        beginKillLadder();
      }, opts.idleTimeoutMs);
    };
    armIdle();

    // Feed the child's stdin. Guard against EPIPE in case the child exits
    // before consuming all input. Each write counts as activity for the idle
    // limit, as output does.
    if (opts.input != null && child.stdin) {
      const stdin = child.stdin;
      stdin.on("error", () => {
        // Child closed stdin early — ignore (e.g. EPIPE).
      });
      if (typeof opts.input === "string") {
        stdin.write(opts.input);
        stdin.end();
      } else {
        const input = opts.input;
        void (async () => {
          try {
            for await (const chunk of input) {
              if (stdin.destroyed || stdin.writableEnded) break;
              stdin.write(chunk);
              armIdle();
            }
          } catch {
            // A failing input source just ends the input.
          }
          if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
        })();
      }
    }

    const onAbort = () => {
      if (killing) return;
      aborted = true;
      beginKillLadder();
    };
    opts.abortController?.signal.addEventListener("abort", onAbort, { once: true });
    if (opts.abortController?.signal.aborted) onAbort();

    const cleanup = () => {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      opts.abortController?.signal.removeEventListener("abort", onAbort);
      liveChildren.delete(child);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    // Resolve/reject only after the child has truly exited. This is the
    // contract that prevents queue-slot leaks.
    child.on("exit", (code, signal) => {
      cleanup();
      const stdoutAll = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderrAll = Buffer.concat(stderrChunks).toString("utf-8");
      const stderr = stderrAll.trim();
      const detail = { stdout: stdoutAll, stderr: stderrAll, elapsedMs: Date.now() - startedAt };
      if (aborted) {
        reject(new CliTerminatedError("aborted", "Aborted", detail));
      } else if (timedOut) {
        reject(new CliTerminatedError(
          "timeout",
          `CLI timed out after ${opts.timeoutMs}ms${stderr ? `: ${stderr.slice(-500)}` : ""}`,
          detail,
        ));
      } else if (idledOut) {
        reject(new CliTerminatedError(
          "idle",
          `No output from the model for ${Math.round((opts.idleTimeoutMs || 0) / 1000)} s; the run was stopped.`,
          detail,
        ));
      } else if (code === null && signal) {
        // Killed from outside (e.g. server shutdown). Its output is incomplete,
        // so it must not be passed off as a finished run.
        reject(new CliTerminatedError("killed", `claude was killed by ${signal}`, detail));
      } else if (code !== null && code !== 0) {
        const tail = stderr || stdoutAll.trim();
        reject(new Error(`claude exited ${code}${tail ? `: ${tail.slice(-1000)}` : ""}`));
      } else {
        resolve(stdoutAll);
      }
    });
  });
}

/**
 * Spawn a command and yield its stdout one line at a time, as each line
 * arrives. Blank lines are skipped. The generator ends when the child exits;
 * if spawnWithAbort would have rejected, it throws the same error after
 * yielding every line read before the failure.
 *
 * `onLine` sees each line the moment it is read, before the consumer does, so
 * timing measured there is arrival time. If the consumer stops early, the
 * child is stopped, and the generator returns only once it has exited.
 */
export async function* streamLines(
  cmd: string | string[],
  opts: SpawnWithAbortOptions & { onLine?: (line: string) => void },
): AsyncGenerator<string> {
  const { onLine, onStdout, abortController: outer, ...spawnOpts } = opts;
  const decoder = new StringDecoder("utf8");
  let queue: string[] = [];
  let head = 0;
  let partial = "";
  let finished = false;
  let failed = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;

  const notify = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  const accept = (line: string) => {
    if (!line.trim()) return;
    try { onLine?.(line); } catch { /* observers must not break the run */ }
    queue.push(line);
  };
  const take = (text: string) => {
    partial += text;
    let nl: number;
    while ((nl = partial.indexOf("\n")) !== -1) {
      accept(partial.slice(0, nl));
      partial = partial.slice(nl + 1);
    }
  };

  // The child gets its own controller, which follows the caller's, so that a
  // consumer that stops early can stop the child as well.
  const ac = new AbortController();
  const follow = () => ac.abort();
  if (outer) {
    if (outer.signal.aborted) follow();
    else outer.signal.addEventListener("abort", follow, { once: true });
  }

  const exited = spawnWithAbort(cmd, {
    ...spawnOpts,
    abortController: ac,
    onStdout: (chunk: Buffer) => {
      try { onStdout?.(chunk); } catch { /* observers must not break the run */ }
      take(decoder.write(chunk));
      notify();
    },
  }).then(
    () => {
      take(decoder.end());
      accept(partial);
      partial = "";
      finished = true;
      notify();
    },
    (err: unknown) => {
      failed = true;
      failure = err;
      finished = true;
      notify();
    },
  );

  try {
    while (true) {
      if (head < queue.length) {
        const line = queue[head++];
        if (head > 1024 && head * 2 > queue.length) {
          queue = queue.slice(head);
          head = 0;
        }
        yield line;
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => { wake = () => resolve(); });
    }
    if (failed) throw failure;
  } finally {
    outer?.signal.removeEventListener("abort", follow);
    if (!finished) {
      ac.abort();
      await exited;
    }
  }
}

/** A stream of lines for a child's stdin. Lines pushed while nobody is reading
 *  wait in order; end() finishes the stream after them. */
class LineFeed implements AsyncIterable<string> {
  private lines: string[] = [];
  private ended = false;
  private wake: (() => void) | null = null;

  push(line: string): void {
    if (this.ended) return;
    this.lines.push(line);
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    if (wake) wake();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.lines.length > 0) {
        yield this.lines.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value != null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

/** The permission callback createCLIQueryFn calls (see wrapPermissionHandler). */
type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/**
 * Build a QueryFn that runs `claude -p` as a cancellable subprocess and yields
 * each NDJSON line of its output, parsed, as soon as the CLI prints it.
 *
 * The conversation goes to the CLI's stdin as stream-json messages. A string
 * prompt is one turn: stdin is closed once its result arrives. An async
 * iterable prompt is a multi-turn Session: the next message is read from it
 * after each result, and stdin is closed when it ends. The CLI's can_use_tool
 * permission requests are answered with options.canUseTool.
 */
export function createCLIQueryFn(cliBin: string): QueryFn {
  return function cliQuery(args: { prompt: unknown; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>> {
    const opts = args.options || {};
    const cmd = buildCLICommand(cliBin, opts);
    const cmdText = formatCommand(cmd);
    const canUseTool = typeof opts.canUseTool === "function" ? opts.canUseTool as CanUseToolFn : null;
    const turns = isAsyncIterable(args.prompt) ? args.prompt[Symbol.asyncIterator]() : null;
    const firstPrompt = turns
      ? ""
      : typeof args.prompt === "string" ? args.prompt : JSON.stringify(args.prompt);

    const traceId = typeof opts.traceId === "string" ? opts.traceId : "";

    return {
      async *[Symbol.asyncIterator]() {
        const ac = opts.abortController as AbortController | undefined;
        // The server's deadline (opts.timeoutMs) decides when a run is given up
        // on. The CLI's own timer sits CLI_BACKSTOP_MS beyond it, so the server
        // always reports the timeout first. A Session waits between turns for
        // as long as its caller does, so it has no hard cap; the idle limit
        // still stops a turn that stalls.
        const serverTimeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
          ? opts.timeoutMs
          : DEFAULT_TIMEOUT_MS;
        const timeoutMs = turns ? undefined : serverTimeoutMs + CLI_BACKSTOP_MS;

        logDiag("info", {
          requestId: traceId,
          message: "cli_spawn",
          model: opts.model ? String(opts.model) : "",
          cwd: opts.cwd ? String(opts.cwd) : "",
          promptChars: firstPrompt.length,
          systemPromptChars: opts.systemPrompt ? String(opts.systemPrompt).length : 0,
          commandHead: cmdText.slice(0, 2000),
        });
        traceWrite(traceId, "command.txt", cmdText);

        // Everything written to the CLI's stdin, in order: user messages and
        // answers to permission requests. prompt.txt records each line as it
        // is sent.
        const feed = new LineFeed();
        const send = (message: Record<string, unknown>) => {
          const line = JSON.stringify(message) + "\n";
          traceAppendRaw(traceId, "prompt.txt", line);
          feed.push(line);
        };

        // While a Session waits for its next message, or a permission handler
        // for its decision, the CLI is silent by design, not stalled.
        let awaitingInput = false;
        let pendingPermissions = 0;

        // After a result: close a one-shot run's stdin, or send a Session's
        // next message once its caller supplies one.
        const nextTurn = async (): Promise<void> => {
          if (!turns) {
            feed.end();
            return;
          }
          awaitingInput = true;
          try {
            const next = await turns.next();
            if (next.done) feed.end();
            else send({ parent_tool_use_id: null, ...(next.value as Record<string, unknown>) });
          } catch {
            feed.end();
          } finally {
            awaitingInput = false;
          }
        };

        // Answer a control_request from the CLI. can_use_tool goes to the
        // permission handler; with none set, the tool use is denied.
        const answerControlRequest = async (msg: Record<string, unknown>): Promise<void> => {
          const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
          const req = msg.request && typeof msg.request === "object" ? msg.request as Record<string, unknown> : {};
          if (req.subtype !== "can_use_tool") {
            send({
              type: "control_response",
              response: { subtype: "error", request_id: requestId, error: `Unsupported control request: ${String(req.subtype)}` },
            });
            return;
          }
          let decision: Record<string, unknown> = { behavior: "deny", message: "No permission handler is set." };
          if (canUseTool) {
            pendingPermissions++;
            try {
              const input = req.input && typeof req.input === "object" ? req.input as Record<string, unknown> : {};
              decision = await canUseTool(String(req.tool_name ?? ""), input, {
                decisionReason: req.decision_reason,
                toolUseID: req.tool_use_id,
                requestId,
              });
            } catch (err) {
              decision = {
                behavior: "deny",
                message: `The permission handler failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            } finally {
              pendingPermissions--;
            }
          }
          send({ type: "control_response", response: { subtype: "success", request_id: requestId, response: decision } });
        };

        if (turns) void nextTurn();
        else send({ type: "user", message: { role: "user", content: firstPrompt }, parent_tool_use_id: null });

        // Each line is recorded and timed as it arrives, so a run that is
        // killed still leaves evidence of how far it got. The longest silence
        // between lines is what separates a stalled run from one that is
        // merely slow.
        const timing = { spawnedAt: Date.now(), lastAt: Date.now(), lines: 0, firstLineMs: -1, maxGapMs: 0, thinkingTokens: 0 };
        const onLine = (line: string) => {
          const now = Date.now();
          const gap = now - timing.lastAt;
          if (gap > timing.maxGapMs) timing.maxGapMs = gap;
          if (timing.firstLineMs < 0) timing.firstLineMs = now - timing.spawnedAt;
          timing.lastAt = now;
          timing.lines++;
          if (line.includes('"thinking_tokens"')) {
            const t = /"estimated_tokens"\s*:\s*(\d+)/.exec(line);
            if (t) timing.thinkingTokens = Math.max(timing.thinkingTokens, Number(t[1]));
          }
          const m = /"type"\s*:\s*"([^"]*)"/.exec(line.slice(0, 200));
          traceAppend(traceId, "cli-stdout.live.ndjson", line);
          traceAppend(traceId, "cli-timing.tsv", `${now - timing.spawnedAt}\t${gap}\t${line.length}\t${m ? m[1] : ""}`);
        };
        const onStderr = (chunk: Buffer) => traceAppendRaw(traceId, "cli-stderr.txt", chunk.toString("utf-8"));
        const logTiming = (outcome: string) => {
          const now = Date.now();
          logDiag("info", {
            requestId: traceId,
            message: "cli_timing",
            outcome,
            totalMs: now - timing.spawnedAt,
            lines: timing.lines,
            peakThinkingTokens: timing.thinkingTokens,
            firstLineMs: timing.firstLineMs,
            maxGapMs: Math.max(timing.maxGapMs, now - timing.lastAt),
            trailingSilenceMs: now - timing.lastAt,
          });
        };

        const idleMs = typeof opts.idleTimeoutMs === "number" && opts.idleTimeoutMs > 0
          ? opts.idleTimeoutMs
          : configuredIdleTimeoutMs;

        // One console line every PROGRESS_INTERVAL_MS while the run is going,
        // so a long thinking turn is visibly alive.
        const progress = setInterval(() => {
          const now = Date.now();
          log("info", {
            requestId: traceId,
            message: "cli_progress",
            model: opts.model ? String(opts.model) : "",
            elapsedS: Math.round((now - timing.spawnedAt) / 1000),
            lines: timing.lines,
            thinkingTokens: timing.thinkingTokens,
            silentS: Math.round((now - timing.lastAt) / 1000),
          });
        }, PROGRESS_INTERVAL_MS);
        progress.unref?.();

        const received: string[] = [];
        const typeCounts: Record<string, number> = {};
        let skipped = 0;
        // Stays "stopped" when the consumer stops reading before the CLI exits.
        let outcome = "stopped";
        try {
          for await (const line of streamLines(cmd, {
            cwd: opts.cwd ? String(opts.cwd) : undefined,
            abortController: ac,
            timeoutMs,
            idleTimeoutMs: idleMs,
            idleExempt: () => awaitingInput || pendingPermissions > 0,
            input: feed,
            onLine,
            onStderr,
          })) {
            received.push(line);
            let obj: Record<string, unknown>;
            try {
              obj = JSON.parse(line) as Record<string, unknown>;
            } catch {
              // A line the CLI printed that is not JSON. Discarding it in silence
              // is exactly how a missing chunk of an answer would vanish without
              // trace, so record it.
              skipped++;
              logDiag("warn", {
                requestId: traceId,
                message: "cli_line_unparsed",
                lineChars: line.length,
                head: line.slice(0, 300),
                tail: line.length > 300 ? line.slice(-300) : "",
              });
              continue;
            }

            const t = typeof obj.type === "string" ? obj.type : "(no type)";
            typeCounts[t] = (typeCounts[t] || 0) + 1;

            // Every rate_limit_event, from one-shot runs and Sessions alike,
            // feeds GET /api/quota (server/quota.ts). It is still yielded.
            if (t === "rate_limit_event") quota.recordRateLimitEvent(obj.rate_limit_info);

            // Permission requests are answered here; the caller never sees them.
            if (t === "control_request") {
              void answerControlRequest(obj);
              continue;
            }

            if (t === "result") {
              // Close a one-shot run's stdin, or send a Session's next message.
              void nextTurn();
              const r = obj.result;
              logDiag("info", {
                requestId: traceId,
                message: "cli_result_line",
                subtype: typeof obj.subtype === "string" ? obj.subtype : "",
                resultChars: typeof r === "string" ? r.length : -1,
                resultHead: typeof r === "string" ? r.slice(0, 200) : "",
                resultTail: typeof r === "string" ? r.slice(-200) : "",
              });
            }

            yield obj;
          }
          outcome = "exited";
        } catch (err) {
          if (err instanceof CliTerminatedError) {
            outcome = err.reason;
            const types: Record<string, number> = {};
            for (const line of err.stdout.split("\n")) {
              const m = /"type"\s*:\s*"([^"]*)"/.exec(line.slice(0, 200));
              if (m) types[m[1]] = (types[m[1]] || 0) + 1;
            }
            logDiag("warn", {
              requestId: traceId,
              message: "cli_terminated",
              reason: err.reason,
              elapsedMs: err.elapsedMs,
              stdoutBytes: Buffer.byteLength(err.stdout),
              stderrBytes: Buffer.byteLength(err.stderr),
              typeCounts: types,
              peakThinkingTokens: timing.thinkingTokens,
              stderrTail: err.stderr.slice(-500),
            });
          } else {
            outcome = "error";
          }
          throw err;
        } finally {
          feed.end();
          clearInterval(progress);
          logTiming(outcome);

          logDiag("info", {
            requestId: traceId,
            message: "cli_stdout",
            bytes: received.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0),
            lines: received.length,
            parsedLines: received.length - skipped,
            skippedLines: skipped,
            typeCounts,
          });
        }
      },
    };
  };
}

async function resolveQueryFn(): Promise<QueryFn> {
  if (cachedQueryFn) return cachedQueryFn;
  const cli = findClaudeCLI();
  if (!cli) throw new AgentError("SDK_NOT_FOUND", CLI_NOT_FOUND_MESSAGE);
  cachedQueryFn = createCLIQueryFn(cli.path);
  return cachedQueryFn;
}

/** What one no-cost start of the claude CLI reported (probeClaudeCLI). */
export interface CLIProbe {
  /** Exit code, or null if the CLI was killed or could not start. */
  exitCode: number | null;
  /** The system/init message, or null if the CLI printed none. */
  init: Record<string, unknown> | null;
  /** The result message, or null if the CLI printed none. */
  result: Record<string, unknown> | null;
  stderr: string;
}

/**
 * Start the claude CLI with the flags `opts` produce (see buildCLICommand) and
 * send it one user message marked `shouldQuery: false`, which the CLI records
 * without calling the model. It costs nothing, yet the CLI still validates
 * every flag and reports its tools and MCP servers in its system/init message.
 * Rejects when there is no claude CLI on PATH.
 */
export async function probeClaudeCLI(opts: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<CLIProbe> {
  const cli = findClaudeCLI();
  if (!cli) throw new AgentError("SDK_NOT_FOUND", CLI_NOT_FOUND_MESSAGE);
  const argv = buildCLICommand(cli.path, opts);
  const input = JSON.stringify({
    type: "user",
    message: { role: "user", content: "ping" },
    parent_tool_use_id: null,
    shouldQuery: false,
  }) + "\n";

  return new Promise<CLIProbe>((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd ? String(opts.cwd) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let init: Record<string, unknown> | null = null;
      let result: Record<string, unknown> | null = null;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as Record<string, unknown>;
          if (m.type === "system" && m.subtype === "init" && !init) init = m;
          if (m.type === "result") result = m;
        } catch {
          // Not JSON; ignore.
        }
      }
      resolve({ exitCode, init, result, stderr });
    };
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.on("error", (err) => { stderr += String(err); finish(null); });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => { /* the CLI exited before reading its input */ });
    child.stdin?.end(input);
  });
}

/** The outcome of verifyClaudeCLI. */
export interface CLIVerification {
  ok: boolean;
  /** The CLI checked, or null when there is none on PATH. */
  cli: ClaudeCLIInfo | null;
  /** Why ok is false. */
  problem?: string;
}

/**
 * Check that the installed claude CLI accepts the flags Otterly passes and,
 * with them, offers no tools and loads no MCP servers. Costs nothing (see
 * probeClaudeCLI). The server refuses to start when this fails.
 */
export async function verifyClaudeCLI(): Promise<CLIVerification> {
  const cli = findClaudeCLI();
  if (!cli) return { ok: false, cli, problem: CLI_NOT_FOUND_MESSAGE };
  const probe = await probeClaudeCLI({});
  if (probe.exitCode !== 0 || !probe.init) {
    const detail = probe.stderr.trim().slice(-500) || "no output";
    return { ok: false, cli, problem: `claude ${cli.version} did not start with Otterly's flags (exit ${probe.exitCode}): ${detail}` };
  }
  const tools = probe.init.tools;
  if (!Array.isArray(tools) || tools.length > 0) {
    return { ok: false, cli, problem: `claude ${cli.version} still offers tools with --tools "": ${JSON.stringify(tools)}` };
  }
  const mcp = probe.init.mcp_servers;
  if (!Array.isArray(mcp) || mcp.length > 0) {
    return { ok: false, cli, problem: `claude ${cli.version} still loads MCP servers with an empty --mcp-config: ${JSON.stringify(mcp)}` };
  }
  return { ok: true, cli };
}

export class ClaudeEngine {
  private defaults: Partial<EngineOptions>;
  private queryFnOverride?: QueryFn;

  constructor(defaults?: Partial<EngineOptions>, queryFn?: QueryFn) {
    this.defaults = defaults || {};
    this.queryFnOverride = queryFn;
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
    const traceId = this.mergeOptions(options).traceId || "";
    const tools: ToolExecution[] = [];
    let resultText = "";
    let resultEventText = "";
    let textFromBlocks = "";
    let textFromDeltas = "";
    let blockCount = 0;
    let deltaCount = 0;
    let cost = 0;
    let duration = 0;
    let sessionId = "";
    let usage = { input_tokens: 0, output_tokens: 0 };
    const pendingToolUses = new Map<string, { tool: string; input: Record<string, unknown> }>();

    for await (const event of this.stream(prompt, options)) {
      switch (event.type) {
        case "text":
          blockCount++;
          textFromBlocks += event.text;
          break;
        case "text_delta":
          deltaCount++;
          textFromDeltas += event.delta;
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
          resultEventText = event.text || resultEventText;
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

    const chosenSource = resultText
      ? "result-event"
      : textFromDeltas
        ? "text-deltas"
        : textFromBlocks
          ? "text-blocks"
          : "empty";

    if (!resultText) {
      resultText = textFromDeltas || textFromBlocks || "";
    }

    // Shows what each candidate source held, which one was used, and how each
    // one began — so a truncated answer can be attributed to a stage.
    logDiag("info", {
      requestId: traceId,
      message: "run_text_sources",
      chosenSource,
      resultEventChars: resultEventText.length,
      blocksChars: textFromBlocks.length,
      deltasChars: textFromDeltas.length,
      blockCount,
      deltaCount,
      finalChars: resultText.length,
      resultEventHead: resultEventText.slice(0, 160),
      blocksHead: textFromBlocks.slice(0, 160),
      deltasHead: textFromDeltas.slice(0, 160),
      finalTail: resultText.slice(-160),
    });
    traceWrite(traceId, "run-result-event.txt", resultEventText);
    traceWrite(traceId, "run-text-blocks.txt", textFromBlocks);
    traceWrite(traceId, "run-text-deltas.txt", textFromDeltas);
    traceWrite(traceId, "run-final.txt", resultText);

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
    const queryFn = this.queryFnOverride || await resolveQueryFn();

    const abortController = new AbortController();
    if (opts.signal) {
      // Carry the caller's reason through: a TIMEOUT AgentError must surface as
      // an error, while a client disconnect ends the stream quietly.
      const signal = opts.signal;
      if (signal.aborted) abortController.abort(signal.reason);
      else signal.addEventListener("abort", () => abortController.abort(signal.reason), { once: true });
    }

    const queryOptions: Record<string, unknown> = {
      abortController,
      cwd: opts.cwd || process.cwd(),
      permissionMode: opts.permissionMode || "bypassPermissions",
    };

    if (opts.model) queryOptions.model = opts.model;
    if (opts.maxTurns !== undefined) queryOptions.maxTurns = opts.maxTurns;
    if (opts.allowedTools) queryOptions.allowedTools = opts.allowedTools;
    if (opts.disallowedTools) queryOptions.disallowedTools = opts.disallowedTools;
    if (opts.mcpServers) queryOptions.mcpServers = opts.mcpServers;
    if (opts.effort) queryOptions.effort = opts.effort;
    if (opts.resume) queryOptions.resume = opts.resume;
    if (opts.traceId) queryOptions.traceId = opts.traceId;
    if (opts.timeoutMs !== undefined) queryOptions.timeoutMs = opts.timeoutMs;
    if (opts.idleTimeoutMs !== undefined) queryOptions.idleTimeoutMs = opts.idleTimeoutMs;
    if (opts.tools) queryOptions.tools = opts.tools;

    // Only a caller-supplied system prompt is forwarded; buildCLICommand fills
    // in a neutral one, so "no system message" never carries a hidden default.
    if (opts.systemPrompt) {
      queryOptions.systemPrompt = String(opts.systemPrompt);
    }

    if (opts.onPermission) {
      queryOptions.permissionMode = "default";
      queryOptions.canUseTool = wrapPermissionHandler(opts.onPermission);
    }

    const ctx = createEventContext();

    try {
      const queryInstance = queryFn({ prompt, options: queryOptions });

      for await (const raw of queryInstance) {
        const rawType = raw.type;
        if (opts.clientToolCalls && rawType === "system" && raw.subtype === "init") {
          const tools = Array.isArray(raw.tools) ? raw.tools : [];
          if (tools.length > 0) {
            logDiag("error", {
              requestId: opts.traceId || "",
              message: "native_tool_inventory_detected",
              tools: tools.filter((tool): tool is string => typeof tool === "string"),
            });
            abortController.abort();
            throw new AgentError(
              "NATIVE_TOOL_CALL",
              "Claude emitted a native tool call instead of an external-client tool request. The response was rejected; execution status must be checked in the trace."
            );
          }
        }
        if (opts.clientToolCalls && rawType === "assistant") {
          const content = raw.message && typeof raw.message === "object" && Array.isArray((raw.message as Record<string, unknown>).content)
            ? (raw.message as Record<string, unknown>).content as unknown[]
            : [];
          const toolUses = content.filter((item): item is Record<string, unknown> =>
            !!item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_use"
          );
          if (toolUses.length > 0) {
            logDiag("error", {
              requestId: opts.traceId || "",
              message: "native_tool_call_blocked",
              tools: toolUses.map((tool) => typeof tool.name === "string" ? tool.name : ""),
            });
            abortController.abort();
            throw new AgentError(
              "NATIVE_TOOL_CALL",
              "Claude emitted a native tool call instead of an external-client tool request. The response was rejected; execution status must be checked in the trace."
            );
          }
        }
        // With partial messages, a native tool call first shows as the start
        // of a tool_use block; reject it there, before the block is written.
        if (opts.clientToolCalls && rawType === "stream_event") {
          const ev = raw.event && typeof raw.event === "object" ? raw.event as Record<string, unknown> : null;
          const block = ev && ev.type === "content_block_start" && ev.content_block && typeof ev.content_block === "object"
            ? ev.content_block as Record<string, unknown>
            : null;
          if (block && typeof block.type === "string" && block.type.endsWith("tool_use")) {
            logDiag("error", {
              requestId: opts.traceId || "",
              message: "native_tool_call_blocked",
              tools: [typeof block.name === "string" ? block.name : ""],
            });
            abortController.abort();
            throw new AgentError(
              "NATIVE_TOOL_CALL",
              "Claude emitted a native tool call instead of an external-client tool request. The response was rejected; execution status must be checked in the trace."
            );
          }
        }
        // An API failure (overload, rate limit, safeguard refusal) arrives as a
        // result line with is_error set, before the CLI exits non-zero. Its
        // `result` text is the clean explanation; surface that, not the exit.
        if (rawType === "result" && raw.is_error === true) {
          const apiStatus = typeof raw.api_error_status === "number" ? raw.api_error_status : null;
          const text = typeof raw.result === "string" && raw.result ? raw.result : `Claude stopped: ${String(raw.subtype)}`;
          log("error", {
            requestId: opts.traceId || "",
            message: "cli_api_error",
            apiErrorStatus: apiStatus,
            terminalReason: typeof raw.terminal_reason === "string" ? raw.terminal_reason : "",
            text: text.slice(0, 500),
          });
          if (opts.structured429ForOpenAI === true && apiStatus === 429) {
            const failure = new CliUsageLimitError(text);
            abortController.abort(failure);
            throw failure;
          }
          abortController.abort();
          throw classifyError(new Error(apiStatus ? `Claude API error ${apiStatus}: ${text}` : text));
        }
        if (abortController.signal.aborted) {
          // The catch below rethrows a timeout and ends quietly for a disconnect.
          throw new Error("Aborted");
        }

        const events = normalizeEvents(raw as Record<string, unknown>, ctx);
        for (const event of events) {
          yield event;
        }
      }
    } catch (err) {
      if (err instanceof CliUsageLimitError && abortController.signal.reason === err && !opts.signal?.aborted) {
        throw err;
      }
      if (err instanceof AgentError && err.code === "NATIVE_TOOL_CALL") {
        throw err;
      }
      const reason = abortController.signal.reason;
      if (abortController.signal.aborted && reason instanceof AgentError && reason.code === "TIMEOUT") {
        throw reason;
      }
      if (err instanceof CliTerminatedError && (err.reason === "timeout" || err.reason === "idle")) {
        throw new AgentError("TIMEOUT", err.message, err);
      }
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
    const override = this.queryFnOverride;
    // Resolve the query function on the first send(), to avoid a top-level await.
    let resolvedFn: QueryFn | null = null;

    const lazyQueryFn: QueryFn = async function* (args) {
      if (!resolvedFn) {
        resolvedFn = override ?? await resolveQueryFn();
      }
      yield* resolvedFn(args);
    };

    return new Session(lazyQueryFn, opts);
  }
}
