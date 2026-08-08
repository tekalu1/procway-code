import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { createTimelineRenderer } from "../src/adapters/tui/timeline-renderer.mjs";
import { stripAnsi } from "../src/adapters/tui/ansi.mjs";

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

    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "tc-1", name: "read_file" }));
    bus.emit(createEvent("tool.call.completed", {
      sessionId: "s-1",
      toolCallId: "tc-1",
      ok: true,
      result: { kind: "read_file", summary: "Read 12 B from x", data: { path: "x" } }
    }));

    expect(writer.text).toContain("● read_file");
    expect(writer.text).toContain("✓ read_file");
  });

  // P1-6: the live feed and the replayed transcript must print the same tool
  // line. `tool.call.started` carries only the name, so the arguments come
  // from the preceding `tool.call.scheduled`.
  it("shows the tool arguments from tool.call.scheduled", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer }).attach(bus);

    bus.emit(createEvent("tool.call.scheduled", {
      sessionId: "s-1",
      toolCallId: "tc-2",
      name: "run_shell",
      args: { command: "pnpm test" },
      mutation: false
    }));
    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "tc-2", name: "run_shell" }));
    bus.emit(createEvent("tool.call.completed", { sessionId: "s-1", toolCallId: "tc-2", ok: true, result: { kind: "run_shell", summary: "exit 0" } }));

    expect(writer.text).toContain('● run_shell(command="pnpm test")');
    expect(writer.text).toContain('✓ run_shell(command="pnpm test")');
  });

  it("marks a failed tool call with ✗", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer }).attach(bus);

    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "tc-3", name: "Edit" }));
    bus.emit(createEvent("tool.call.completed", { sessionId: "s-1", toolCallId: "tc-3", ok: false, result: { kind: "edit", summary: "nope" } }));

    expect(writer.text).toContain("✗ Edit");
  });

  it("does not print the tool result body on the live feed", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer }).attach(bus);

    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "tc-4", name: "read_file" }));
    bus.emit(createEvent("tool.call.completed", {
      sessionId: "s-1",
      toolCallId: "tc-4",
      ok: true,
      result: { kind: "read_file", summary: "Read 12 B", data: { content: "SECRET BODY" } }
    }));

    expect(writer.text).not.toContain("SECRET BODY");
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

/**
 * P3b-2: the live feed printed each tool call twice (once from
 * `activity.started`, once from `tool.call.started`), stamped every line with
 * a locale 12-hour clock, ticked the spinner at 1fps, and ran a spinner frame
 * straight into the next line with no newline between them.
 */
describe("timeline renderer — Phase 3b cleanups", () => {
  it("does not double-report a tool call that also emits activity.started", () => {
    const writer = makeTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer, intervalMs: 100000 }).attach(bus);

    bus.emit(createEvent("tool.call.scheduled", { sessionId: "s", toolCallId: "tc", name: "read_file", args: { filePath: "a.mjs" }, mutation: false }));
    bus.emit(createEvent("activity.started", { sessionId: "s", activityId: "act", label: "tool:read_file", detail: "running" }));
    bus.emit(createEvent("tool.call.started", { sessionId: "s", toolCallId: "tc", name: "read_file" }));
    bus.emit(createEvent("activity.stopped", { sessionId: "s", activityId: "act", outcome: "done" }));
    bus.emit(createEvent("tool.call.completed", { sessionId: "s", toolCallId: "tc", ok: true, result: { kind: "read_file", summary: "ok" } }));

    expect(writer.text).not.toContain("tool:read_file");
    expect(writer.text.split("read_file").length - 1).toBe(2);
  });

  it("prints no timestamps", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer, intervalMs: 100000 }).attach(bus);
    bus.emit(createEvent("activity.started", { sessionId: "s", activityId: "a", label: "model waiting", detail: "round=0" }));
    bus.emit(createEvent("activity.stopped", { sessionId: "s", activityId: "a", outcome: "response received" }));
    expect(writer.text).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(writer.text).not.toMatch(/\[(AM|PM)]/);
  });

  it("spins at ~10fps, not 1fps", () => {
    const writer = makeTtyWriter();
    const bus = new EventBus();
    const renderer = createTimelineRenderer({ writer }).attach(bus);
    expect(renderer.intervalMs).toBeLessThanOrEqual(120);
    expect(renderer.intervalMs).toBeGreaterThanOrEqual(60);
    renderer.detach();
  });

  it("clears the transient spinner row before the next line lands on it", () => {
    const writer = makeTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer, intervalMs: 100000 }).attach(bus);
    bus.emit(createEvent("activity.started", { sessionId: "s", activityId: "a", label: "model waiting", detail: "round=0" }));
    bus.emit(createEvent("activity.stopped", { sessionId: "s", activityId: "a", outcome: "failed" }));
    // The close-out line is preceded by an erase, and the whole feed ends in a
    // newline — the reported `(0s)[11:44:14 PM] model waiting failed` splice
    // cannot happen.
    expect(stripAnsi(writer.text)).toMatch(/\r.*model waiting failed/s);
    expect(writer.text.endsWith("\n")).toBe(true);
  });

  it("routes through the controller's transient writer when it has one", () => {
    const calls = [];
    const writer = {
      isTTY: true,
      write: (value) => calls.push(["write", value]),
      writeTransient: (value) => calls.push(["transient", value])
    };
    const bus = new EventBus();
    createTimelineRenderer({ writer, intervalMs: 100000 }).attach(bus);
    bus.emit(createEvent("activity.started", { sessionId: "s", activityId: "a", label: "model waiting" }));
    expect(calls[0][0]).toBe("transient");
    expect(calls[0][1]).not.toContain("\r");
  });

  it("holds the spinner still while something is reading keys", () => {
    const writer = makeTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer, intervalMs: 100000, isBusy: () => true }).attach(bus);
    bus.emit(createEvent("activity.started", { sessionId: "s", activityId: "a", label: "model waiting" }));
    expect(writer.text).toBe("");
  });

  it("throttles the non-TTY heartbeat instead of writing 10 lines a second", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    const renderer = createTimelineRenderer({ writer, heartbeatMs: 100000 }).attach(bus);
    bus.emit(createEvent("activity.started", { sessionId: "s", activityId: "a", label: "model waiting" }));
    const first = writer.text;
    // A second frame within the heartbeat window writes nothing.
    renderer.activeActivities.get("a").lastHeartbeatAt = Date.now();
    expect(writer.text).toBe(first);
    renderer.detach();
  });
});
