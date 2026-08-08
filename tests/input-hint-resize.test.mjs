import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createInputController } from "../src/adapters/tui/input-controller.mjs";
import { createStreamingRenderer } from "../src/adapters/tui/streaming-renderer.mjs";

function makeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  return input;
}

function makeOutput({ columns = 80 } = {}) {
  const emitter = new EventEmitter();
  emitter.isTTY = true;
  emitter.columns = columns;
  emitter.rows = 24;
  emitter.buffer = "";
  emitter.write = (value) => { emitter.buffer += value; return true; };
  return emitter;
}

function type(input, text) {
  input.emit("data", Buffer.from(text, "utf8"));
}

describe("SIGWINCH (P3b-11)", () => {
  it("repaints the prompt when the terminal is resized", () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    controller.question("❯ ").catch(() => {});
    type(input, "hello");
    const before = output.buffer.length;
    output.columns = 40;
    output.emit("resize");
    expect(output.buffer.length).toBeGreaterThan(before);
    expect(output.buffer.slice(before)).toContain("hello");
    controller.dispose();
  });

  it("reflows the streaming renderer to the new width", () => {
    const renderer = createStreamingRenderer({ writer: { write() {}, isTTY: true }, width: 80 });
    expect(renderer.setWidth(42)).toBe(42);
    expect(renderer.width).toBe(42);
    // Nonsense values are ignored rather than producing a 0-column wrap.
    renderer.setWidth("wide");
    expect(renderer.width).toBe(42);
  });
});

describe("transient writes (P3b-2)", () => {
  it("clears a spinner row before the next full line", () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    controller.writer.writeTransient("⠋ model waiting (1s)");
    output.buffer = "";
    controller.writer.write("✓ done\n");
    expect(output.buffer).toBe("\r\x1b[2K✓ done\n");
    controller.dispose();
  });

  it("refuses to paint over a live prompt", () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    controller.question({ prompt: "Approve? ", level: 1 }).catch(() => {});
    output.buffer = "";
    expect(controller.writer.writeTransient("⠋ spinning")).toBe(false);
    expect(output.buffer).toBe("");
    expect(controller.isReading).toBe(true);
    controller.dispose();
  });
});
