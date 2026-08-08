import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { createReasoningRenderer } from "../src/adapters/tui/reasoning-render.mjs";
import { stripAnsi, visibleWidth } from "../src/adapters/tui/ansi.mjs";

function makeWriter() {
  let buffer = "";
  return { isTTY: true, write(value) { buffer += value; }, get text() { return buffer; } };
}

/**
 * P3b-8: `assistant.reasoning.delta` has been on the bus since Phase 2 and the
 * dashboard renders it — the CLI subscribed to nothing, so the only signal
 * that a multi-minute reasoning phase is alive was thrown away.
 */
describe("reasoning renderer", () => {
  it("prints complete lines with a gutter, buffering partial ones", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    createReasoningRenderer({ writer }).attach(bus);

    bus.emit(createEvent("assistant.reasoning.delta", { sessionId: "s", messageId: "m", deltaText: "I should read " }));
    expect(writer.text).toBe("");
    bus.emit(createEvent("assistant.reasoning.delta", { sessionId: "s", messageId: "m", deltaText: "the renderer\nthen" }));
    expect(writer.text).toBe("┊ I should read the renderer\n");
  });

  it("flushes the tail when the answer starts", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    createReasoningRenderer({ writer }).attach(bus);
    bus.emit(createEvent("assistant.reasoning.delta", { sessionId: "s", messageId: "m", deltaText: "half a thought" }));
    bus.emit(createEvent("assistant.message.delta", { sessionId: "s", messageId: "m", deltaText: "Answer" }));
    expect(writer.text).toContain("half a thought");
  });

  it("wraps to the terminal width", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    createReasoningRenderer({ writer, width: () => 30 }).attach(bus);
    bus.emit(createEvent("assistant.reasoning.delta", {
      sessionId: "s",
      messageId: "m",
      deltaText: "this is a fairly long reasoning line that must be wrapped\n"
    }));
    const lines = writer.text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith("┊ ")).toBe(true);
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it("dims the output when colour is on", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    createReasoningRenderer({ writer, colorize: true }).attach(bus);
    bus.emit(createEvent("assistant.reasoning.delta", { sessionId: "s", messageId: "m", deltaText: "thinking\n" }));
    expect(writer.text).toContain("[");
    expect(stripAnsi(writer.text)).toBe("┊ thinking\n");
  });

  it("can be switched off and back on", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createReasoningRenderer({ writer }).attach(bus);
    renderer.setEnabled(false);
    expect(renderer.isEnabled()).toBe(false);
    bus.emit(createEvent("assistant.reasoning.delta", { sessionId: "s", messageId: "m", deltaText: "hidden\n" }));
    expect(writer.text).toBe("");
    renderer.setEnabled(true);
    bus.emit(createEvent("assistant.reasoning.delta", { sessionId: "s", messageId: "m", deltaText: "shown\n" }));
    expect(writer.text).toBe("┊ shown\n");
  });

  it("starts disabled when the setting says so, and detaches cleanly", () => {
    const writer = makeWriter();
    const bus = new EventBus();
    const renderer = createReasoningRenderer({ writer, enabled: false }).attach(bus);
    bus.emit(createEvent("assistant.reasoning.delta", { sessionId: "s", messageId: "m", deltaText: "nope\n" }));
    expect(writer.text).toBe("");
    renderer.detach();
    renderer.setEnabled(true);
    bus.emit(createEvent("assistant.reasoning.delta", { sessionId: "s", messageId: "m", deltaText: "after detach\n" }));
    expect(writer.text).toBe("");
  });
});
