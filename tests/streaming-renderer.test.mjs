import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { createStreamingRenderer } from "../src/adapters/tui/streaming-renderer.mjs";
import { stripAnsi } from "../src/adapters/tui/ansi.mjs";

function makeWriter() {
  let buffer = "";
  return {
    isTTY: false,
    columns: 80,
    write(value) { buffer += value; return true; },
    get text() { return buffer; }
  };
}

function tick(bus, deltas, messageId = "m-1", sessionId = "s-1") {
  for (const text of deltas) {
    bus.emit(createEvent("assistant.message.delta", { sessionId, messageId, deltaText: text }));
  }
}

describe("streaming renderer (single-sink)", () => {
  it("appends text deltas to a single writer", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["Hello ", "world\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "Hello world" }]
    }));
    expect(writer.text).toContain("Hello world");
    renderer.detach();
  });

  it("defers fenced code block rendering until the closing fence", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["pre line\n", "```js\n", "const x = ", "1;\n"]);
    expect(writer.text).toContain("pre line");
    expect(writer.text).not.toContain("const x = 1;");
    tick(bus, ["```\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "ok" }]
    }));
    expect(writer.text).toContain("const x = 1;");
    renderer.detach();
  });

  it("adds a single trailing newline on completion when streaming", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["partial line"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "partial line" }]
    }));
    expect(writer.text.endsWith("partial line\n")).toBe(true);
    renderer.detach();
  });

  it("renders Markdown when colorize is true (single-sink integration)", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: true, width: 60 }).attach(bus);
    tick(bus, ["# Title\n", "and body **bold**\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "..." }]
    }));
    expect(writer.text).toContain("\x1b[1m");
    expect(stripAnsi(writer.text)).toContain("# Title");
    renderer.detach();
  });

  it("survives consecutive delta events without races", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    for (let i = 0; i < 100; i += 1) {
      bus.emit(createEvent("assistant.message.delta", { sessionId: "s-1", messageId: "m-1", deltaText: `chunk-${i}\n` }));
    }
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "ok" }]
    }));
    expect(writer.text).toContain("chunk-0");
    expect(writer.text).toContain("chunk-99");
    renderer.detach();
  });

  it("hadOutput() stays true after streaming completes (so completion fallbacks skip)", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["| a | b |\n", "|---|---|\n", "| 1 | 2 |\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "| a | b |\n|---|---|\n| 1 | 2 |\n" }]
    }));
    expect(renderer.isStreaming()).toBe(false);
    expect(renderer.hadOutput()).toBe(true);
    renderer.detach();
  });

  it("resets output tracking on user.prompt.submitted so subsequent turns can use the fallback", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createStreamingRenderer({ writer, colorize: false }).attach(bus);
    tick(bus, ["first turn output\n"]);
    bus.emit(createEvent("assistant.message.completed", {
      sessionId: "s-1",
      messageId: "m-1",
      content: [{ kind: "text", text: "first turn output" }]
    }));
    expect(renderer.hadOutput()).toBe(true);
    bus.emit(createEvent("user.prompt.submitted", {
      sessionId: "s-1",
      messageId: "m-2",
      content: [{ kind: "text", text: "next prompt" }]
    }));
    expect(renderer.hadOutput()).toBe(false);
    renderer.detach();
  });
});
