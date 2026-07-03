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

describe("Ctrl+C two-stage interrupt handler", () => {
  it("first SIGINT calls onTurnAbort and announces interrupt", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let aborted = 0;
    let exited = null;
    const handler = attachInterruptHandler({
      session: { abort() { aborted += 1; } },
      output,
      onTurnAbort: () => { aborted += 1; },
      process: proc,
      exit: (code) => { exited = code; }
    });
    handler.trigger();
    expect(aborted).toBe(2);
    expect(exited).toBeNull();
    expect(output.text).toContain("interrupting current turn");
    expect(output.text).toContain("press again to exit");
    handler.dispose();
  });

  it("second SIGINT within window calls exit(130)", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let exited = null;
    const handler = attachInterruptHandler({
      session: { abort() {} },
      output,
      process: proc,
      exit: (code) => { exited = code; },
      windowMs: 1000
    });
    handler.trigger();
    handler.trigger();
    expect(exited).toBe(130);
    expect(output.text).toContain("exiting");
    handler.dispose();
  });

  it("dispose() removes the SIGINT listener so subsequent signals are ignored", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let exited = null;
    let aborted = 0;
    const handler = attachInterruptHandler({
      session: { abort() { aborted += 1; } },
      output,
      process: proc,
      exit: (code) => { exited = code; }
    });
    handler.dispose();
    proc.emit("SIGINT");
    expect(aborted).toBe(0);
    expect(exited).toBeNull();
  });

  it("two presses outside the window remain in the first-stage interrupt state", () => {
    const proc = makeFakeProcess();
    const output = makeWriter();
    let exited = null;
    const session = { abortCount: 0, abort() { this.abortCount += 1; } };
    const handler = attachInterruptHandler({
      session,
      output,
      process: proc,
      exit: (code) => { exited = code; },
      windowMs: 1
    });
    handler.trigger();
    return new Promise((resolve) => {
      setTimeout(() => {
        handler.trigger();
        expect(exited).toBeNull();
        expect(session.abortCount).toBe(2);
        handler.dispose();
        resolve();
      }, 5);
    });
  });
});
