// Regression tests for the CLI-path worker-slot leak.
//
// Before this fix, the CLI path ran `claude -p` via `execSync` inside a worker
// thread. When the request was aborted, `worker.terminate()` killed the worker
// but the underlying `claude` subprocess was orphaned and kept running until
// it exited naturally — for a hung interactive prompt, "naturally" means
// "never." The upstream request queue holds a slot as long as the worker
// promise is pending; the orphan child made the promise resolve OK from the
// queue's POV but the system as a whole leaked because Claude Code kept its
// stdio fd alive on the original spawn parent.
//
// The actual symptom in production: every `--max-concurrent` slot fills up
// with hung calls within minutes of any agentic use, the queue starts
// rejecting requests, and otterly is dead until restarted. See
// https://github.com/josharsh/otterly/issues/4.
//
// These tests pin the new contract enforced by `spawnWithAbort`:
//
//   - On abort, the child process actually dies within killGraceMs + buffer.
//   - The returned promise rejects only AFTER the child has truly exited.
//   - When the child exits normally, stdout comes through verbatim.
//   - When the hard timeout fires, the kill ladder fires and the error
//     surfaces a useful suffix of stderr.

import { describe, it, expect } from "vitest";
import { spawnWithAbort } from "../src/engine.js";

// Helper: check whether a PID is still alive. process.kill(pid, 0) throws
// ESRCH if the process is gone. We treat EPERM as "alive" defensively.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true; // EPERM etc → assume alive
  }
}

// Sleep helper (real time — these tests are timing-sensitive by design).
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("spawnWithAbort — queue-slot leak regression", () => {
  it("kills a hung child on abort and rejects after it exits", async () => {
    // sleep 30 = guaranteed long-running, no stdout. The whole point is
    // simulating Claude Code hanging on an interactive prompt.
    const ac = new AbortController();
    let capturedPid: number | undefined;
    const spawnSpy: typeof import("child_process").spawn = ((cmd: string, args: readonly string[], opts: unknown) => {
      // Use the real spawn but capture the resulting child so we can verify
      // it actually dies. We swap in spawnFn so the test can stay synchronous.
      const realSpawn = require("child_process").spawn;
      const child = realSpawn(cmd, args, opts);
      capturedPid = child.pid;
      return child;
    }) as unknown as typeof import("child_process").spawn;

    const startedAt = Date.now();
    const promise = spawnWithAbort("sleep 30", {
      timeoutMs: 60_000,
      abortController: ac,
      killGraceMs: 500,
      spawnFn: spawnSpy,
    });

    // Wait briefly so the child has time to start before we abort.
    await wait(50);
    expect(capturedPid).toBeDefined();
    expect(isAlive(capturedPid!)).toBe(true);

    // Fire the abort.
    ac.abort();

    // The promise must reject — but only after the child is gone.
    await expect(promise).rejects.toThrow("Aborted");
    const elapsed = Date.now() - startedAt;

    // Must have resolved well within killGraceMs + SIGKILL buffer (<2s).
    // If we ever regress to the old behavior, this is 30s.
    expect(elapsed).toBeLessThan(2000);

    // The whole point: the child is actually dead now.
    expect(isAlive(capturedPid!)).toBe(false);
  });

  it("hard-timeout triggers the same kill ladder", async () => {
    let capturedPid: number | undefined;
    const spawnSpy: typeof import("child_process").spawn = ((cmd: string, args: readonly string[], opts: unknown) => {
      const realSpawn = require("child_process").spawn;
      const child = realSpawn(cmd, args, opts);
      capturedPid = child.pid;
      return child;
    }) as unknown as typeof import("child_process").spawn;

    const startedAt = Date.now();
    const promise = spawnWithAbort("sleep 30", {
      timeoutMs: 200,
      killGraceMs: 300,
      spawnFn: spawnSpy,
    });

    await expect(promise).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - startedAt;

    // Should fire ~timeoutMs + small kill latency.
    expect(elapsed).toBeLessThan(2000);
    expect(capturedPid).toBeDefined();
    expect(isAlive(capturedPid!)).toBe(false);
  });

  it("returns stdout verbatim when the command exits normally", async () => {
    const out = await spawnWithAbort("printf 'hello\\nworld\\n'", {
      timeoutMs: 5000,
    });
    expect(out).toBe("hello\nworld\n");
  });

  it("does not leak slots: 10 sequential aborts all complete quickly", async () => {
    // A representative stress test for the queue-leak contract: 10 hung
    // children, each aborted in turn. Each must release before the next
    // starts. Total wall time must stay bounded.
    const startedAt = Date.now();
    for (let i = 0; i < 10; i++) {
      const ac = new AbortController();
      const p = spawnWithAbort("sleep 30", {
        timeoutMs: 60_000,
        abortController: ac,
        killGraceMs: 200,
      });
      setTimeout(() => ac.abort(), 20);
      await expect(p).rejects.toThrow("Aborted");
    }
    const elapsed = Date.now() - startedAt;
    // 10 iterations × (~20ms before abort + ~50ms kill latency) ≈ <2s.
    // Old behavior (worker.terminate + orphan child) would be 10 × 30s = 5min.
    expect(elapsed).toBeLessThan(5000);
  });

  it("surfaces stderr in the timeout error message", async () => {
    // sh -c 'echo boom >&2; sleep 30' — produces stderr then hangs.
    const promise = spawnWithAbort("echo boom >&2; sleep 30", {
      timeoutMs: 150,
      killGraceMs: 200,
    });
    await expect(promise).rejects.toThrow(/boom/);
  });
});
