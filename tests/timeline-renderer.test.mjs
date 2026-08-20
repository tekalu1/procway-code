import { describe, expect, it, vi } from "vitest";
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
 * P3-14: a tool call used to print two rows — `● run_shell(…)` when it starts
 * and a second `✓ run_shell(…)` when it finishes. On a real terminal the finish
 * line now OVERWRITES the start line in place, so the tool takes one row for
 * its whole lifecycle instead of two.
 */
describe("timeline renderer — P3-14 one-row tool lifecycle", () => {
  it("overwrites the started line in place on a TTY", () => {
    const writer = makeTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer }).attach(bus);

    bus.emit(createEvent("tool.call.scheduled", { sessionId: "s-1", toolCallId: "tc-1", name: "run_shell", args: { command: "pnpm test" }, mutation: false }));
    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "tc-1", name: "run_shell" }));
    expect(stripAnsi(writer.text)).toContain("● run_shell(command=\"pnpm test\")");

    bus.emit(createEvent("tool.call.completed", { sessionId: "s-1", toolCallId: "tc-1", ok: true, result: { kind: "run_shell", summary: "exit 0" } }));

    // The completion rewinds one row, clears it, and rewrites it with ✓ —
    // i.e. no second row is appended.
    expect(writer.text).toContain("\x1b[1A\r\x1b[2K");
    expect(stripAnsi(writer.text)).toContain("✓ run_shell(command=\"pnpm test\")");
    // After the in-place rewrite the feed is a single logical row: the ✓ line
    // is the last thing, and both the ● and ✓ occupy that same line.
    expect(stripAnsi(writer.text).endsWith("✓ run_shell(command=\"pnpm test\")\n")).toBe(true);
  });

  it("falls back to a fresh row when something was written in between (e.g. parallel tool)", () => {
    const writer = makeTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer }).attach(bus);

    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "a", name: "read_file" }));
    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "b", name: "grep" }));
    bus.emit(createEvent("tool.call.completed", { sessionId: "s-1", toolCallId: "a", ok: true, result: { kind: "read_file", summary: "ok" } }));

    // `grep`'s start landed between `read_file`'s start and completion, so we
    // cannot safely rewind — append a new completion row instead.
    expect(writer.text).not.toContain("\x1b[1A");
    expect(stripAnsi(writer.text)).toContain("✓ read_file");
  });

  it("does not emit control codes on a non-TTY sink", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    createTimelineRenderer({ writer }).attach(bus);

    bus.emit(createEvent("tool.call.started", { sessionId: "s-1", toolCallId: "tc-1", name: "Edit" }));
    bus.emit(createEvent("tool.call.completed", { sessionId: "s-1", toolCallId: "tc-1", ok: false, result: { kind: "edit", summary: "nope" } }));

    expect(writer.text).not.toContain("\x1b[1A");
    expect(writer.text).toContain("● Edit");
    expect(writer.text).toContain("✗ Edit");
    expect(writer.text.split("\n").filter((l) => l.trim() !== "")).toHaveLength(2);
  });
});

/**
 * P3-19: while a tool is in flight its row is overwritten in place, so it can
 * carry a live spinner without the row growing — the ● marker animates through
 * the FRAMES cadence and freezes back to ✓/✗ on completion. TTY-only; a piped
 * sink keeps the static ● since it cannot repaint in place.
 */
describe("timeline renderer — running tool bullet animation", () => {
  it("animates the running tool's bullet on a TTY and freezes to ✓ on completion", () => {
    vi.useFakeTimers();
    try {
      const writer = makeTtyWriter();
      const bus = new EventBus();
      createTimelineRenderer({ writer, intervalMs: 100 }).attach(bus);

      bus.emit(createEvent("tool.call.scheduled", { sessionId: "s", toolCallId: "tc", name: "run_shell", args: { command: "pnpm test" }, mutation: false }));
      bus.emit(createEvent("tool.call.started", { sessionId: "s", toolCallId: "tc", name: "run_shell" }));

      const afterStart = writer.text.length;
      expect(stripAnsi(writer.text)).toContain("● run_shell(command=\"pnpm test\")");

      // One interval tick repaints the row in place with a spinner frame.
      vi.advanceTimersByTime(100);
      const tick = stripAnsi(writer.text.slice(afterStart));
      expect(tick).toContain("\x1b[1A\r\x1b[2K");
      expect(tick).toMatch(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);
      // The repaint rewound out of the way (one \x1b[1A) instead of committing
      // a new row, so the completion below can still overwrite in place.
      expect(writer.text.match(/\x1b\[1A\r\x1b\[2K/g) ?? []).toHaveLength(1);

      bus.emit(createEvent("tool.call.completed", { sessionId: "s", toolCallId: "tc", ok: true, result: { kind: "run_shell", summary: "exit 0" } }));
      expect(stripAnsi(writer.text).endsWith("✓ run_shell(command=\"pnpm test\")\n")).toBe(true);
      // The completion also rewound in place (a second \x1b[1A) rather than
      // appending a row — the whole lifecycle stayed on the single start row.
      expect(writer.text.match(/\x1b\[1A\r\x1b\[2K/g) ?? []).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start the animation on a non-TTY sink", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    const renderer = createTimelineRenderer({ writer });
    renderer.attach(bus);

    bus.emit(createEvent("tool.call.scheduled", { sessionId: "s", toolCallId: "tc", name: "run_shell", args: { command: "x" }, mutation: false }));
    bus.emit(createEvent("tool.call.started", { sessionId: "s", toolCallId: "tc", name: "run_shell" }));

    expect(renderer.toolSpinner).toBeNull();
    expect(writer.text).not.toContain("⠋");
    renderer.detach();
  });
});

/**
 * P3-20: compaction now gets the same running/completed affordance as tools.
 * `compact.started` opens a one-row spinner ("compacting conversation …") and
 * `compact.applied` overwrites it in place with ✓ compacted (or ○ no-op), so a
 * slow context compaction is never mistaken for an idle/blank TUI.
 */
describe("timeline renderer — compaction progress", () => {
  it("shows a running spinner for compaction and overwrites it in place with the result", () => {
    vi.useFakeTimers();
    try {
      const writer = makeTtyWriter();
      const bus = new EventBus();
      createTimelineRenderer({ writer, intervalMs: 100 }).attach(bus);

      bus.emit(createEvent("compact.started", { sessionId: "s", strategy: "llm-summary" }));
      const afterStart = writer.text.length;
      expect(stripAnsi(writer.text)).toContain("● compacting conversation (strategy=llm-summary)");

      // One interval tick repaints the row in place with a spinner frame.
      vi.advanceTimersByTime(100);
      const tick = stripAnsi(writer.text.slice(afterStart));
      expect(tick).toContain("\x1b[1A\r\x1b[2K");
      expect(tick).toMatch(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);
      expect(writer.text.match(/\x1b\[1A\r\x1b\[2K/g) ?? []).toHaveLength(1);

      bus.emit(createEvent("compact.applied", { sessionId: "s", strategy: "llm-summary" }));
      expect(stripAnsi(writer.text).endsWith("✓ compacting conversation compacted (strategy=llm-summary)\n")).toBe(true);
      expect(writer.text.match(/\x1b\[1A\r\x1b\[2K/g) ?? []).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a `compacted:false` no-op as a static done row", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    const renderer = createTimelineRenderer({ writer }).attach(bus);
    bus.emit(createEvent("compact.started", { sessionId: "s", strategy: "drop-tool-results" }));
    bus.emit(createEvent("compact.applied", { sessionId: "s", strategy: "drop-tool-results", compacted: false }));
    expect(stripAnsi(writer.text)).toContain("○ compacting conversation done (nothing to compact)");
    renderer.detach();
  });

  it("does not emit control codes for compaction on a non-TTY sink", () => {
    const writer = makeNonTtyWriter();
    const bus = new EventBus();
    const renderer = createTimelineRenderer({ writer }).attach(bus);
    bus.emit(createEvent("compact.started", { sessionId: "s", strategy: "x" }));
    expect(renderer.toolSpinner).toBeNull();
    expect(writer.text).not.toContain("\x1b[1A");
    renderer.detach();
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

  // Dock sink: the running tool row lives ONLY on the transient status row —
  // if the "● …" text carried the trailing `\n` that `renderToolCall` produces,
  // the dock would draw it with a real line-feed, pushing the row into the
  // scrollback and leaving a stale "● list_files(dir=.)" row under the later
  // "✓ list_files(dir=.)" row. The transient must be a single newline-free row.
  it("keeps the running tool row off the scrollback on a dock writer", () => {
    const calls = [];
    const writer = {
      isTTY: true,
      hasDock: true,
      write: (value) => calls.push(["write", value]),
      writeTransient: (value) => calls.push(["transient", value]),
      clearTransient: () => calls.push(["clear"])
    };
    const bus = new EventBus();
    const renderer = createTimelineRenderer({ writer, intervalMs: 100000, colorize: false }).attach(bus);

    bus.emit(createEvent("tool.call.scheduled", {
      sessionId: "s",
      toolCallId: "tc-9",
      name: "list_files",
      args: { dir: "." }
    }));
    bus.emit(createEvent("tool.call.started", { sessionId: "s", toolCallId: "tc-9", name: "list_files" }));

    // The start line is transient-only: never committed to the feed, and the
    // transient text is exactly one row with no trailing newline.
    const startCalls = calls.filter(([kind]) => kind === "transient");
    expect(startCalls.length).toBe(1);
    expect(startCalls[0][1]).toContain("● list_files(dir=.)");
    expect(startCalls[0][1]).not.toContain("\n");
    expect(calls.some(([kind, value]) => kind === "write" && value.includes("●"))).toBe(false);

    bus.emit(createEvent("tool.call.completed", {
      sessionId: "s",
      toolCallId: "tc-9",
      ok: true,
      result: { kind: "list_files", summary: "2 entries" }
    }));

    // Completion clears the transient status row and commits exactly ONE
    // result row to the feed.
    expect(calls).toContainEqual(["clear"]);
    const feedRows = calls.filter(([kind, value]) => kind === "write" && value.includes("list_files"));
    expect(feedRows.length).toBe(1);
    expect(feedRows[0][1]).toContain("✓ list_files(dir=.)");
    renderer.detach();
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
