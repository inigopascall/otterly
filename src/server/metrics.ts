// In-memory rolling metrics for the dashboard.
// Tracks request totals, cost, tokens, latency, top tools, and recent runs.
// Bounded: keeps the last N runs only.

const MAX_RECENT = 50;

export type Endpoint = "run" | "stream" | "chat" | "ws";

export interface RecordedRun {
  ts: number;            // epoch ms
  endpoint: Endpoint;
  status: number;        // HTTP status
  durationMs: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  error?: string;
}

export interface MetricsSnapshot {
  totals: {
    requests: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    errors: number;
  };
  today: {
    requests: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
    errors: number;
  };
  topTools: Array<{ tool: string; count: number }>;
  recent: RecordedRun[];
  startedAt: number;
}

class Metrics {
  private startedAt = Date.now();
  private totalRequests = 0;
  private totalCost = 0;
  private totalInput = 0;
  private totalOutput = 0;
  private totalToolCalls = 0;
  private totalErrors = 0;
  private toolCounts = new Map<string, number>();
  private recent: RecordedRun[] = [];

  record(run: RecordedRun): void {
    this.totalRequests++;
    this.totalCost += run.cost || 0;
    this.totalInput += run.inputTokens || 0;
    this.totalOutput += run.outputTokens || 0;
    this.totalToolCalls += run.toolCalls || 0;
    if (run.status >= 400 || run.error) this.totalErrors++;

    this.recent.unshift(run);
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
  }

  recordToolUse(tool: string): void {
    this.toolCounts.set(tool, (this.toolCounts.get(tool) || 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayStart = startOfDay.getTime();

    let tReq = 0, tCost = 0, tIn = 0, tOut = 0, tLatSum = 0, tErr = 0;
    for (const r of this.recent) {
      if (r.ts < todayStart) continue;
      tReq++;
      tCost += r.cost;
      tIn += r.inputTokens;
      tOut += r.outputTokens;
      tLatSum += r.durationMs;
      if (r.status >= 400 || r.error) tErr++;
    }

    const topTools = [...this.toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tool, count]) => ({ tool, count }));

    return {
      totals: {
        requests: this.totalRequests,
        cost: this.totalCost,
        inputTokens: this.totalInput,
        outputTokens: this.totalOutput,
        toolCalls: this.totalToolCalls,
        errors: this.totalErrors,
      },
      today: {
        requests: tReq,
        cost: tCost,
        inputTokens: tIn,
        outputTokens: tOut,
        avgLatencyMs: tReq > 0 ? Math.round(tLatSum / tReq) : 0,
        errors: tErr,
      },
      topTools,
      recent: this.recent.slice(0, 25),
      startedAt: this.startedAt,
    };
  }

  reset(): void {
    this.startedAt = Date.now();
    this.totalRequests = 0;
    this.totalCost = 0;
    this.totalInput = 0;
    this.totalOutput = 0;
    this.totalToolCalls = 0;
    this.totalErrors = 0;
    this.toolCounts.clear();
    this.recent = [];
  }
}

export const metrics = new Metrics();
