import { describe, expect, it } from "vitest";
import { createTurnQueue } from "../src/adapters/tui/turn-queue.mjs";
import {
  createWakeInjector,
  drainTurnQueue,
  makeWakeItem,
  readWakeText
} from "../src/adapters/tui/turn-executor.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A recording executor over a real queue (the REPL's exact wiring). */
function makeHarness({ dispatchConsumes = () => false } = {}) {
  const queue = createTurnQueue();
  const seen = { dispatched: [], messages: [], wakes: [] };
  const drained = drainTurnQueue({
    queue,
    dispatch: async (line) => {
      seen.dispatched.push(line);
      return dispatchConsumes(line);
    },
    runMessage: async (line) => { seen.messages.push(line); },
    runWake: async (text) => { seen.wakes.push(text); }
  });
  return { queue, seen, drained, inject: createWakeInjector({ queue }) };
}

describe("turn executor — wake items (event-wake #143)", () => {
  it("readWakeText recognises a wake item and ignores everything else", () => {
    expect(readWakeText(makeWakeItem("hi"))).toBe("hi");
    expect(readWakeText("hi")).toBeNull();
    expect(readWakeText({ kind: "command", text: "hi" })).toBeNull();
    expect(readWakeText(makeWakeItem("   "))).toBeNull();
    expect(readWakeText(null)).toBeNull();
  });

  it("the injector puts the wake on the same FIFO the user's lines use", async () => {
    const h = makeHarness();
    expect(await h.inject("<system-reminder>run finished</system-reminder>")).toBe(true);
    await tick();
    h.queue.close();
    await h.drained;
    expect(h.seen.wakes).toEqual(["<system-reminder>run finished</system-reminder>"]);
    expect(h.seen.dispatched).toEqual([]);
    expect(h.seen.messages).toEqual([]);
  });

  it("a wake body starting with / is NOT taken for a slash command", async () => {
    const h = makeHarness({ dispatchConsumes: () => true });
    await h.inject("/tmp/out.txt was written by the child agent");
    await tick();
    h.queue.close();
    await h.drained;
    expect(h.seen.wakes).toEqual(["/tmp/out.txt was written by the child agent"]);
    // dispatch is the only thing that could have eaten it — it never saw it.
    expect(h.seen.dispatched).toEqual([]);
  });

  it("a wake body is never routed through the @/!-expanding message path", async () => {
    const h = makeHarness();
    await h.inject("child wrote @docs/plan.md — run !ls to see it");
    await tick();
    h.queue.close();
    await h.drained;
    // runMessage is where expandInput() lives in the REPL; a wake must not
    // reach it or an approval prompt would pop for text the user never typed.
    expect(h.seen.messages).toEqual([]);
    expect(h.seen.wakes).toHaveLength(1);
  });

  it("an empty wake is dropped before it reaches the queue", async () => {
    const h = makeHarness();
    expect(await h.inject("")).toBe(false);
    expect(await h.inject("   \n ")).toBe(false);
    expect(h.queue.size).toBe(0);
    h.queue.close();
    await h.drained;
    expect(h.seen.wakes).toEqual([]);
  });

  it("the injector reports false (and never throws) once the queue is closed", async () => {
    const h = makeHarness();
    h.queue.close();
    await h.drained;
    await expect(h.inject("late wake")).resolves.toBe(false);
  });

  it("a wake pushed during a turn runs after it, in FIFO order", async () => {
    const queue = createTurnQueue();
    const order = [];
    let releaseTurn;
    const turnGate = new Promise((resolve) => { releaseTurn = resolve; });
    const drained = drainTurnQueue({
      queue,
      dispatch: async () => false,
      runMessage: async (line) => {
        order.push(`message:${line}`);
        // Simulate a long turn: the wake arrives while this is still running.
        await turnGate;
        order.push(`message-done:${line}`);
      },
      runWake: async (text) => { order.push(`wake:${text}`); }
    });
    const inject = createWakeInjector({ queue });

    queue.push("do the thing");
    await tick();
    await inject("background work settled");
    queue.push("and then this");
    await tick();
    // Still inside the first turn — nothing else may have started.
    expect(order).toEqual(["message:do the thing"]);

    releaseTurn();
    await tick();
    queue.close();
    await drained;
    expect(order).toEqual([
      "message:do the thing",
      "message-done:do the thing",
      "wake:background work settled",
      "message:and then this",
      "message-done:and then this"
    ]);
  });

  it("plain lines still go to dispatch first and the model second", async () => {
    const h = makeHarness({ dispatchConsumes: (line) => line === "/help" });
    h.queue.push("/help");
    h.queue.push("  hello  ");
    h.queue.push("   ");
    await tick();
    h.queue.close();
    await h.drained;
    expect(h.seen.dispatched).toEqual(["/help", "hello"]);
    expect(h.seen.messages).toEqual(["hello"]);
    expect(h.seen.wakes).toEqual([]);
  });
});
