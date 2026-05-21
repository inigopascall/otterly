import { describe, it, expect, beforeEach } from "vitest";
import { apiSessions } from "../../src/server/session-store.js";

describe("ApiSessionStore", () => {
  beforeEach(() => {
    // Clean up any leftover sessions
    for (let i = 0; i < 100; i++) {
      apiSessions.delete(`test-${i}`);
    }
  });

  it("creates and retrieves sessions", () => {
    apiSessions.create("s1", { data: "hello" });
    const session = apiSessions.get("s1");
    expect(session).not.toBeNull();
    expect(session!.data).toBe("hello");
    expect(session!.metadata.createdAt).toBeTypeOf("number");
    apiSessions.delete("s1");
  });

  it("returns null for missing sessions", () => {
    expect(apiSessions.get("nonexistent")).toBeNull();
  });

  it("tracks count", () => {
    const before = apiSessions.count();
    apiSessions.create("c1", {});
    apiSessions.create("c2", {});
    expect(apiSessions.count()).toBe(before + 2);
    apiSessions.delete("c1");
    apiSessions.delete("c2");
    expect(apiSessions.count()).toBe(before);
  });

  it("updates lastActivity on get", () => {
    apiSessions.create("a1", {});
    const session1 = apiSessions.get("a1")!;

    // Manually set lastActivity to the past
    session1.metadata.lastActivity = 1000;

    // get() should update lastActivity to current time
    const session2 = apiSessions.get("a1")!;
    expect(session2.metadata.lastActivity).toBeGreaterThan(1000);
    apiSessions.delete("a1");
  });

  it("aborts controller on delete", () => {
    const controller = new AbortController();
    apiSessions.create("ab1", { abortController: controller });
    expect(controller.signal.aborted).toBe(false);
    apiSessions.delete("ab1");
    expect(controller.signal.aborted).toBe(true);
  });

  it("delete is idempotent", () => {
    apiSessions.create("d1", {});
    apiSessions.delete("d1");
    apiSessions.delete("d1"); // no-op
    expect(apiSessions.get("d1")).toBeNull();
  });

  it("evicts LRU when at max capacity", () => {
    // Create sessions up to a reasonable count
    // The default maxSessions is 20, so create 20 sessions
    for (let i = 0; i < 20; i++) {
      apiSessions.create(`lru-${i}`, { idx: i });
    }

    // Access some to make them more recently used
    apiSessions.get("lru-5");
    apiSessions.get("lru-10");

    // Creating one more should evict the LRU (lru-0, since lru-5 and lru-10 were touched)
    apiSessions.create("lru-new", { idx: "new" });
    expect(apiSessions.count()).toBe(20); // still at max

    // lru-0 should have been evicted (it was least recently used)
    expect(apiSessions.get("lru-0")).toBeNull();

    // Clean up
    for (let i = 0; i <= 20; i++) {
      apiSessions.delete(`lru-${i}`);
    }
    apiSessions.delete("lru-new");
  });

  it("tracks request count and cost", () => {
    apiSessions.create("rc1", {});
    apiSessions.recordRequest("rc1", 0.05);
    apiSessions.recordRequest("rc1", 0.03);
    const session = apiSessions.get("rc1")!;
    expect(session.metadata.requestCount).toBe(2);
    expect(session.metadata.totalCost).toBeCloseTo(0.08);
    apiSessions.delete("rc1");
  });
});
