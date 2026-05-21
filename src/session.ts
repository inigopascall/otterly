import type {
  AgentEvent,
  AgentResult,
  EngineOptions,
  ToolExecution,
} from "./types.js";
import { normalizeEvents, createEventContext, type EventContext } from "./events.js";
import { classifyError, AgentError } from "./errors.js";
import { wrapPermissionHandler } from "./permissions.js";

type QueryFn = (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;

/**
 * Multi-turn session that keeps conversation context alive across send() calls.
 *
 * Uses the SDK's streaming input mode: an async generator yields user messages
 * on demand, and the SDK processes them within one long-lived query() call.
 *
 * Internally, the SDK iteration runs in the background. Events are queued and
 * pulled by sendStream(). After a result event, sendStream() returns but the
 * background loop continues — allowing the SDK to call prompt.next() and await
 * the next user message.
 */
export class Session {
  private options: EngineOptions;
  private queryFn: QueryFn;
  private messageResolve: ((msg: unknown) => void) | null = null;
  private abortController: AbortController;
  private ctx: EventContext;
  private _sessionId: string | null = null;
  private closed = false;
  private started = false;

  // Event queue: background iteration pushes events, sendStream() pulls them
  private eventQueue: AgentEvent[] = [];
  private eventWaiter: ((event: AgentEvent | null) => void) | null = null;
  private backgroundDone = false;
  private backgroundError: Error | null = null;

  constructor(queryFn: QueryFn, options: EngineOptions) {
    this.queryFn = queryFn;
    this.options = options;
    this.abortController = new AbortController();
    this.ctx = createEventContext();

    if (options.signal) {
      options.signal.addEventListener("abort", () => this.abortController.abort());
    }
  }

  /** Session ID from the SDK. Available after first send(). */
  get id(): string | null {
    return this._sessionId;
  }

  /** Send a message and collect the full result. */
  async send(prompt: string): Promise<AgentResult> {
    const tools: ToolExecution[] = [];
    let resultText = "";
    let cost = 0;
    let duration = 0;
    let sessionId = "";
    let usage = { input_tokens: 0, output_tokens: 0 };
    const pendingToolUses = new Map<string, { tool: string; input: Record<string, unknown> }>();

    for await (const event of this.sendStream(prompt)) {
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

  /** Send a message and stream events. */
  async *sendStream(prompt: string): AsyncGenerator<AgentEvent> {
    if (this.closed) {
      throw new AgentError("ABORTED", "Session has been closed.");
    }

    if (!this.started) {
      // First call: start the query with the prompt baked into the message stream
      this.started = true;
      this.startBackground(prompt);
    } else {
      // Subsequent calls: feed the message into the running generator
      if (!this.messageResolve) {
        // Wait a tick — the background loop may be about to set messageResolve
        await new Promise((r) => setTimeout(r, 0));
      }
      if (!this.messageResolve) {
        throw new AgentError(
          "UNKNOWN",
          "Session is busy processing. Wait for the previous send() to complete."
        );
      }

      this.messageResolve({
        type: "user",
        message: { role: "user", content: prompt },
      });
      this.messageResolve = null;
    }

    // Pull events from the queue until we get a result or error
    while (true) {
      const event = await this.pullEvent();
      if (event === null) break;

      if (event.type === "system") {
        this._sessionId = event.sessionId;
      }

      yield event;

      if (event.type === "result" || event.type === "error") {
        return;
      }
    }
  }

  /** End the session and clean up. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.messageResolve) {
      this.messageResolve(null);
      this.messageResolve = null;
    }
    this.abortController.abort();
    this.backgroundDone = true;

    // Unblock any pending pullEvent()
    if (this.eventWaiter) {
      this.eventWaiter(null);
      this.eventWaiter = null;
    }
  }

  private pushEvent(event: AgentEvent | null): void {
    if (this.eventWaiter) {
      const waiter = this.eventWaiter;
      this.eventWaiter = null;
      waiter(event);
    } else if (event !== null) {
      this.eventQueue.push(event);
    }
  }

  private pullEvent(): Promise<AgentEvent | null> {
    if (this.eventQueue.length > 0) {
      return Promise.resolve(this.eventQueue.shift()!);
    }
    if (this.backgroundDone) {
      if (this.backgroundError) {
        return Promise.reject(classifyError(this.backgroundError));
      }
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.eventWaiter = resolve;
    });
  }

  private startBackground(firstPrompt: string): void {
    const self = this;

    async function* messageStream() {
      yield {
        type: "user",
        message: { role: "user", content: firstPrompt },
      };

      while (true) {
        const msg: unknown = await new Promise((resolve) => {
          self.messageResolve = resolve;
        });
        if (msg === null) return;
        yield msg;
      }
    }

    const queryOptions: Record<string, unknown> = {
      abortController: this.abortController,
      cwd: this.options.cwd || process.cwd(),
      permissionMode: this.options.permissionMode || "bypassPermissions",
      includePartialMessages: true,
    };

    if (this.options.model) queryOptions.model = this.options.model;
    if (this.options.maxTurns) queryOptions.maxTurns = this.options.maxTurns;
    if (this.options.allowedTools) queryOptions.allowedTools = this.options.allowedTools;
    if (this.options.disallowedTools) queryOptions.disallowedTools = this.options.disallowedTools;
    if (this.options.mcpServers) queryOptions.mcpServers = this.options.mcpServers;
    if (this.options.effort) queryOptions.effort = this.options.effort;
    if (this.options.resume) queryOptions.resume = this.options.resume;
    if (this.options.systemPrompt) queryOptions.systemPrompt = this.options.systemPrompt;

    if (this.options.onPermission) {
      queryOptions.permissionMode = "default";
      queryOptions.canUseTool = wrapPermissionHandler(this.options.onPermission);
    }

    // Run the iteration in the background — push events to the queue
    (async () => {
      let queryInstance: AsyncIterable<Record<string, unknown>>;
      try {
        queryInstance = this.queryFn({
          prompt: messageStream(),
          options: queryOptions,
        });
      } catch (err) {
        this.backgroundError = err instanceof Error ? err : new Error(String(err));
        this.pushEvent({
          type: "error",
          error: classifyError(this.backgroundError),
        });
        this.backgroundDone = true;
        this.pushEvent(null);
        return;
      }
      try {
        for await (const raw of queryInstance) {
          if (this.abortController.signal.aborted) break;
          const events = normalizeEvents(raw as Record<string, unknown>, this.ctx);
          for (const event of events) {
            this.pushEvent(event);
          }
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || this.abortController.signal.aborted)
        ) {
          // Cancelled — don't push error
        } else {
          this.backgroundError = err instanceof Error ? err : new Error(String(err));
          this.pushEvent({
            type: "error",
            error: classifyError(this.backgroundError),
          });
        }
      } finally {
        this.backgroundDone = true;
        this.pushEvent(null);
      }
    })();
  }
}
