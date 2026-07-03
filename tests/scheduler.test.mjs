import { describe, expect, it, vi } from "vitest";
import { runToolCalls } from "../src/agent/scheduler.mjs";

function makeCall({ id, ok = true, value = "v", delay = 0, mutation = false }) {
  return {
    index: id,
    id: `call-${id}`,
    name: "stub",
    mutation,
    run: async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (!ok) throw new Error("planned failure");
      return value;
    }
  };
}

function makeHangingCall(id) {
  return {
    index: id,
    id: `call-${id}`,
    name: "hang",
    mutation: false,
    run: () => new Promise(() => {}) // never resolves
  };
}

describe("runToolCalls", () => {
  it("returns ok=true results for fast tools", async () => {
    const results = await runToolCalls([
      makeCall({ id: 0, value: "a" }),
      makeCall({ id: 1, value: "b" })
    ]);
    expect(results.map((r) => ({ id: r.id, ok: r.ok, result: r.result }))).toEqual([
      { id: "call-0", ok: true, result: "a" },
      { id: "call-1", ok: true, result: "b" }
    ]);
  });

  it("captures thrown errors as ok=false", async () => {
    const [result] = await runToolCalls([makeCall({ id: 0, ok: false })]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/planned failure/);
  });

  it("returns ok=false with a timeout marker when a tool hangs (regression: TK-15)", async () => {
    vi.useFakeTimers();
    try {
      const promise = runToolCalls(
        [makeHangingCall(0), makeCall({ id: 1, value: "b" })],
        { timeoutMs: 5_000 }
      );
      await vi.advanceTimersByTimeAsync(6_000);
      const results = await promise;
      // Index-sorted, so the hung tool is at position 0.
      expect(results[0].id).toBe("call-0");
      expect(results[0].ok).toBe(false);
      expect(results[0].timedOut).toBe(true);
      expect(results[0].error).toMatch(/timed out after 5000ms/);
      // The healthy sibling still returns a result.
      expect(results[1].id).toBe("call-1");
      expect(results[1].ok).toBe(true);
      expect(results[1].result).toBe("b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run mutation tools in parallel", async () => {
    const order = [];
    const make = (id) => ({
      index: id,
      id: `call-${id}`,
      name: "mut",
      mutation: true,
      run: async () => {
        order.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end-${id}`);
        return id;
      }
    });
    await runToolCalls([make(0), make(1)]);
    expect(order).toEqual(["start-0", "end-0", "start-1", "end-1"]);
  });

  it("preserves index order when read-only and mutation tools are mixed", async () => {
    const results = await runToolCalls([
      makeCall({ id: 0, value: "ro-a" }),
      makeCall({ id: 1, value: "mut-b", mutation: true }),
      makeCall({ id: 2, value: "ro-c" })
    ]);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(results.map((r) => r.result)).toEqual(["ro-a", "mut-b", "ro-c"]);
  });
});
