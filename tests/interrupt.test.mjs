import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { attachInterruptHandler } from "../src/adapters/tui/interrupt.mjs";

function makeWriter() {
  let buffer = "";
  return {
    isTTY: false,
    write(value) { buffer += value; return true; },
    get text() { return buffer; }
  };
}

function makeFakeProcess() {
  return new EventEmitter();
}

/**
 * P2-4 changed the contract: the first press no longer *always* aborts. It
 * aborts while a turn is running and clears the input line while idle, and
 * only the idle path arms the two-press exit.
 */
describe("Ctrl+C two-stage interrupt handler", () => {
  it("first SIGINT during a turn calls onTurnAbort and announces the interrupt", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let aborted = 0;
    let exited = null;
    const handler = attachInterruptHandler({
      session: { runningTurn: true, abort() { aborted += 1; } },
      output,
      onTurnAbort: () => { aborted += 1; },
      process: proc,
      exit: (code) => { exited = code; }
    });
    handler.trigger();
    expect(aborted).toBe(2);
    expect(exited).toBeNull();
    expect(output.text).toContain("Interrupted by user");
    handler.dispose();
  });

  it("second SIGINT within window calls exit(130) when idle", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let exited = null;
    const handler = attachInterruptHandler({
      session: { runningTurn: false, abort() {} },
      output,
      process: proc,
      exit: (code) => { exited = code; },
      windowMs: 1000
    });
    handler.trigger();
    expect(output.text).toContain("Press Ctrl-C again to exit");
    handler.trigger();
    expect(exited).toBe(130);
    handler.dispose();
  });

  it("dispose() removes the SIGINT listener so subsequent signals are ignored", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let exited = null;
    let aborted = 0;
    const handler = attachInterruptHandler({
      session: { runningTurn: true, abort() { aborted += 1; } },
      output,
      process: proc,
      exit: (code) => { exited = code; }
    });
    handler.dispose();
    proc.emit("SIGINT");
    expect(aborted).toBe(0);
    expect(exited).toBeNull();
  });

  it("two presses outside the window remain in the first-stage state", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let exited = null;
    let cleared = 0;
    const handler = attachInterruptHandler({
      session: { runningTurn: false, abort() {} },
      output,
      onIdleFirstPress: () => { cleared += 1; },
      process: proc,
      exit: (code) => { exited = code; },
      windowMs: 1
    });
    handler.trigger();
    return new Promise((resolve) => {
      setTimeout(() => {
        handler.trigger();
        expect(exited).toBeNull();
        expect(cleared).toBe(2);
        handler.dispose();
        resolve();
      }, 5);
    });
  });

  it("idle: the first press clears the input line and does NOT abort the session", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let aborted = 0;
    let cleared = 0;
    const handler = attachInterruptHandler({
      isTurnRunning: () => false,
      session: { abort() { aborted += 1; } },
      output,
      onIdleFirstPress: () => { cleared += 1; },
      process: proc,
      exit: () => {}
    });
    handler.trigger();
    expect(aborted).toBe(0);
    expect(cleared).toBe(1);
    expect(output.text).toContain("(Press Ctrl-C again to exit)");
    handler.dispose();
  });

  it("interrupting a turn resets the exit counter — a double tap never quits", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let exited = null;
    const session = { runningTurn: true, aborts: 0, abort() { this.aborts += 1; } };
    const handler = attachInterruptHandler({
      session,
      output,
      process: proc,
      exit: (code) => { exited = code; },
      windowMs: 10_000
    });
    handler.trigger();
    handler.trigger();
    expect(exited).toBeNull();
    expect(session.aborts).toBe(2);
    // Once the turn has ended, two presses exit as usual.
    session.runningTurn = false;
    handler.trigger();
    expect(exited).toBeNull();
    handler.trigger();
    expect(exited).toBe(130);
    handler.dispose();
  });

  it("Esc interrupts a running turn and clears the line when idle, never exiting", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let exited = null;
    let cleared = 0;
    const session = { runningTurn: true, aborts: 0, abort() { this.aborts += 1; } };
    const handler = attachInterruptHandler({
      session,
      output,
      onIdleFirstPress: () => { cleared += 1; },
      process: proc,
      exit: (code) => { exited = code; }
    });
    handler.triggerEscape();
    expect(session.aborts).toBe(1);
    session.runningTurn = false;
    handler.triggerEscape();
    handler.triggerEscape();
    expect(cleared).toBe(2);
    expect(exited).toBeNull();
    handler.dispose();
  });

  it("runs onExit before exiting so shutdown() can save and reap", () => {
    const proc = makeFakeProcess();
    const order = [];
    const handler = attachInterruptHandler({
      session: { runningTurn: false, abort() {} },
      output: makeWriter(),
      onExit: () => order.push("shutdown"),
      process: proc,
      exit: () => order.push("exit")
    });
    handler.trigger();
    handler.trigger();
    expect(order).toEqual(["shutdown", "exit"]);
    handler.dispose();
  });
});
