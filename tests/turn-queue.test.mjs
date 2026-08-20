import { describe, expect, it } from "vitest";
import { createTurnQueue } from "../src/adapters/tui/turn-queue.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("turn queue — FIFO (single producer / single consumer)", () => {
  it("yields items in submission order", async () => {
    const q = createTurnQueue();
    q.push("a");
    q.push("b");
    q.push("c");
    expect((await q.next()).value).toBe("a");
    expect((await q.next()).value).toBe("b");
    expect((await q.next()).value).toBe("c");
    expect(q.size).toBe(0);
  });

  it("a parked consumer wakes when an item is pushed later", async () => {
    const q = createTurnQueue();
    const pending = q.next(); // consumer parks (empty & not closed)
    await tick();
    expect(q.size).toBe(0);
    q.push("later");
    expect((await pending).value).toBe("later");
  });

  it("close wakes a parked consumer with done:true", async () => {
    const q = createTurnQueue();
    const pending = q.next();
    await tick();
    q.close();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it("next after close resolves done:true", async () => {
    const q = createTurnQueue();
    q.close();
    expect(await q.next()).toEqual({ value: undefined, done: true });
  });

  it("push after close is dropped and reports false", async () => {
    const q = createTurnQueue();
    q.close();
    expect(q.push("nope")).toBe(false);
    expect(q.size).toBe(0);
  });

  it("size counts un-consumed items", () => {
    const q = createTurnQueue();
    q.push("a");
    q.push("b");
    expect(q.size).toBe(2);
    // Drain one via a pre-resolved next()
    void q.next().then(() => {});
  });
});

describe("turn queue — executor drain pattern", () => {
  it("drains queued lines one at a time until close", async () => {
    const q = createTurnQueue();
    const seen = [];
    const executor = (async () => {
      for (;;) {
        const { value, done } = await q.next();
        if (done) break;
        seen.push(value); // simulate one turn per item
      }
    })();
    q.push("m1");
    q.push("m2");
    q.push({ type: "command", text: "/help" });
    await tick();
    q.close();
    await executor;
    expect(seen).toEqual(["m1", "m2", { type: "command", text: "/help" }]);
  });

  it("close resolves even if items were never consumed", async () => {
    const q = createTurnQueue();
    q.push("leftover");
    q.close();
    expect(q.closed).toBe(true);
    expect(q.size).toBe(1); // a real consumer would drain; here we just verify close is idempotent
  });

  it("close(error) rejects a parked consumer with that error", async () => {
    const q = createTurnQueue();
    const pending = q.next();
    await tick();
    const boom = new Error("boom");
    q.close(boom);
    await expect(pending).rejects.toThrow("boom");
  });
});
