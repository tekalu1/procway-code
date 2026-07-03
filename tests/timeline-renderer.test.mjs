import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { createTimelineRenderer } from "../src/adapters/tui/timeline-renderer.mjs";

function makeNonTtyWriter() {
  let buffer = "";
  return {
    isTTY: false,
    write(value) {
      buffer += value;
    },
    get text() {
      return buffer;
    }
  };
}

function makeTtyWriter() {
  let buffer = "";
  return {
    isTTY: true,
    write(value) {
      buffer += value;
    },
    get text() {
      return buffer;
    }
  };
}

describe("timeline renderer (event subscriber)", () => {
  it("renders activity.started and activity.stopped frames in non-TTY mode", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    const renderer = createTimelineRenderer({ writer, intervalMs: 100000 }).attach(bus);

    bus.emit(createEvent("activity.started", {
      sessionId: "s-1",
      activityId: "act-1",
      label: "model waiting",
      detail: "round=0"
    }));
    bus.emit(createEvent("activity.stopped", {
      sessionId: "s-1",
      activityId: "act-1",
      outcome: "response received"
    }));

    expect(writer.text).toContain("model waiting");
    expect(writer.text).toContain("still waiting");
    expect(writer.text).toContain("response received");
    renderer.detach();
  });

  it("emits a tool line for tool.call.started and tool.call.completed", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer }).attach(bus);

    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "tc-1" }));
    bus.emit(createEvent("tool.call.completed", {
      sessionId: "s-1",
      toolCallId: "tc-1",
      ok: true,
      result: { kind: "read_file", summary: "Read 12 B from x", data: { path: "x" } }
    }));

    expect(writer.text).toContain("tool start id=tc-1");
    expect(writer.text).toContain("tool ok read_file");
  });

  it("does not write anything when disabled", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer, enabled: false }).attach(bus);

    bus.emit(createEvent("activity.started", {
      sessionId: "s-1",
      activityId: "act-2",
      label: "noop"
    }));
    bus.emit(createEvent("activity.stopped", {
      sessionId: "s-1",
      activityId: "act-2",
      outcome: "done"
    }));

    expect(writer.text).toBe("");
  });

  it("ignores activity.stopped without a matching started", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer }).attach(bus);

    bus.emit(createEvent("activity.stopped", {
      sessionId: "s-1",
      activityId: "missing",
      outcome: "ignored"
    }));

    expect(writer.text).toBe("");
  });

  it("clears the spinner line on the first assistant.message.delta and skips the close-out frame", () => {
    const writer = makeTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer, intervalMs: 100000 }).attach(bus);

    bus.emit(createEvent("activity.started", {
      sessionId: "s-1",
      activityId: "act-stream",
      label: "model waiting",
      detail: "round=0"
    }));
    const lengthBeforeDelta = writer.text.length;

    bus.emit(createEvent("assistant.message.delta", {
      sessionId: "s-1",
      messageId: "m-1",
      deltaText: "hi"
    }));
    const lengthAfterDelta = writer.text.length;
    expect(writer.text.slice(lengthBeforeDelta)).toContain("\r\x1b[2K");

    bus.emit(createEvent("assistant.message.delta", {
      sessionId: "s-1",
      messageId: "m-1",
      deltaText: "more"
    }));
    expect(writer.text.length).toBe(lengthAfterDelta);

    bus.emit(createEvent("activity.stopped", {
      sessionId: "s-1",
      activityId: "act-stream",
      outcome: "response received"
    }));
    expect(writer.text).not.toContain("response received");
  });

  it("still prints the close-out frame when no streaming delta arrived", () => {
    const writer = makeTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer, intervalMs: 100000 }).attach(bus);

    bus.emit(createEvent("activity.started", {
      sessionId: "s-1",
      activityId: "act-no-stream",
      label: "model waiting",
      detail: "round=0"
    }));
    bus.emit(createEvent("activity.stopped", {
      sessionId: "s-1",
      activityId: "act-no-stream",
      outcome: "response received"
    }));

    expect(writer.text).toContain("response received");
  });
});
