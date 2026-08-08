import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  pickSession,
  printSessionChoices,
  renderPickerFrame,
  resolvePageSize,
  stepSelection
} from "../src/adapters/tui/session-picker.mjs";
import { createInputController } from "../src/adapters/tui/input-controller.mjs";
import { stripAnsi, visibleWidth } from "../src/adapters/tui/ansi.mjs";

const NOW = Date.parse("2026-08-04T12:00:00Z");

function makeSessions(count) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `s-${index}`,
    updatedAt: new Date(NOW - (index + 1) * 3600_000).toISOString(),
    model: index % 2 === 0 ? "gpt-5.4" : "claude-opus-4-7",
    messageCount: index,
    title: index === 1 ? null : `Session number ${index}`
  }));
}

/** A TTY-ish stdin/stdout pair driven by `type()`. */
function makeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  return input;
}

function makeOutput({ columns = 80, rows = 24 } = {}) {
  const emitter = new EventEmitter();
  emitter.isTTY = true;
  emitter.columns = columns;
  emitter.rows = rows;
  emitter.buffer = "";
  emitter.write = (value) => { emitter.buffer += value; return true; };
  return emitter;
}

function type(input, text) {
  input.emit("data", Buffer.from(text, "utf8"));
}

describe("session picker rows (P3b-5)", () => {
  it("shows relative time, message count and title instead of an ISO id", () => {
    const { lines } = renderPickerFrame({ sessions: makeSessions(2), selected: 0, pageSize: 10, width: 80, now: NOW });
    const body = lines.join("\n");
    expect(body).toContain("1 hour ago");
    expect(body).toContain("Session number 0");
    // The untitled row is labelled, not blank.
    expect(body).toContain("(untitled)");
    expect(body).toContain("0 msgs");
  });

  it("aligns the columns and marks the selection", () => {
    const { lines } = renderPickerFrame({ sessions: makeSessions(3), selected: 1, pageSize: 10, width: 80, now: NOW });
    const rows = lines.filter((line) => /ago/.test(line));
    expect(rows).toHaveLength(3);
    expect(rows[1].startsWith("❯ ")).toBe(true);
    // Every row's title starts at the same column.
    const titleColumns = rows.map((row) => row.indexOf("Session") >= 0 ? row.indexOf("Session") : row.indexOf("(untitled)"));
    expect(new Set(titleColumns).size).toBe(1);
  });

  it("pages instead of printing all 200 sessions", () => {
    const sessions = makeSessions(40);
    const first = renderPickerFrame({ sessions, selected: 0, pageSize: 10, width: 80, now: NOW });
    expect(first.lines.filter((line) => /ago/.test(line))).toHaveLength(10);
    expect(first.lines.at(-1)).toContain("page 1/4");
    const last = renderPickerFrame({ sessions, selected: 35, pageSize: 10, width: 80, now: NOW });
    expect(last.lines.at(-1)).toContain("page 4/4");
    expect(last.lines.join("\n")).toContain("Session number 35");
  });

  it("keeps the frame inside a narrow terminal", () => {
    const { lines } = renderPickerFrame({ sessions: makeSessions(5), selected: 0, pageSize: 5, width: 60, now: NOW });
    for (const line of lines) expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
  });

  it("sizes the page from the terminal height", () => {
    expect(resolvePageSize({ rows: 24, total: 100 })).toBe(12);
    expect(resolvePageSize({ rows: 12, total: 100 })).toBe(6);
    expect(resolvePageSize({ rows: 6, total: 100 })).toBe(3);
    expect(resolvePageSize({ rows: 40, total: 2 })).toBe(3);
  });
});

describe("session picker key map", () => {
  const base = { selected: 2, total: 5, pageSize: 2 };

  it("wraps up/down around the list", () => {
    expect(stepSelection({ ...base, name: "down" })).toEqual({ action: "render", selected: 3 });
    expect(stepSelection({ ...base, selected: 4, name: "down" })).toEqual({ action: "render", selected: 0 });
    expect(stepSelection({ ...base, selected: 0, name: "up" })).toEqual({ action: "render", selected: 4 });
  });

  it("pages with PgUp/PgDn, Home and End", () => {
    expect(stepSelection({ ...base, name: "pagedown" }).selected).toBe(4);
    expect(stepSelection({ ...base, name: "pageup" }).selected).toBe(0);
    expect(stepSelection({ ...base, name: "end" }).selected).toBe(4);
    expect(stepSelection({ ...base, name: "home" }).selected).toBe(0);
  });

  // The bug: `printf '\n'` produces LF, and the old picker only accepted CR,
  // so every non-interactive driver hung forever.
  it("accepts LF as well as CR", () => {
    expect(stepSelection({ ...base, name: "return" }).action).toBe("accept");
    expect(stepSelection({ ...base, name: "linefeed" }).action).toBe("accept");
  });

  it("cancels on q, Esc and Ctrl+C", () => {
    expect(stepSelection({ ...base, name: "q" }).action).toBe("cancel");
    expect(stepSelection({ ...base, name: "escape" }).action).toBe("cancel");
    expect(stepSelection({ ...base, name: "c", ctrl: true }).action).toBe("cancel");
    expect(stepSelection({ ...base, name: "x" }).action).toBeNull();
  });
});

describe("session picker over the shared controller", () => {
  it("repaints in place — three ↓ presses do not stack three copies", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const sessions = makeSessions(5);
    const picked = pickSession({ sessions, input, output, controller, now: () => NOW });
    await Promise.resolve();
    type(input, "\x1b[B\x1b[B\x1b[B");
    type(input, "\r");
    const chosen = await picked;
    expect(chosen.sessionId).toBe("s-3");
    // The old picker cleared the screen per keypress; the new one rewinds.
    expect(output.buffer).not.toContain("\x1b[2J");
    expect(output.buffer).toContain("\x1b[0J");
    // One header per repaint is expected, but the SCROLLBACK does not grow:
    // each repaint is preceded by a cursor-up rewind.
    const frames = output.buffer.split("Resume a session").length - 1;
    const rewinds = (output.buffer.match(/\x1b\[\d+A/g) ?? []).length;
    expect(frames).toBeGreaterThan(1);
    expect(rewinds).toBe(frames - 1);
    controller.dispose();
  });

  it("accepts a bare LF without hanging", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const picked = pickSession({ sessions: makeSessions(3), input, output, controller, now: () => NOW });
    await Promise.resolve();
    type(input, "\n");
    await expect(picked).resolves.toMatchObject({ sessionId: "s-0" });
    controller.dispose();
  });

  it("cancels with q", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const picked = pickSession({ sessions: makeSessions(3), input, output, controller, now: () => NOW });
    await Promise.resolve();
    type(input, "q");
    await expect(picked).resolves.toBeNull();
    controller.dispose();
  });

  it("repaints on SIGWINCH", async () => {
    const input = makeTty();
    const output = makeOutput();
    const controller = createInputController({ input, output }).start();
    const picked = pickSession({ sessions: makeSessions(3), input, output, controller, now: () => NOW });
    await Promise.resolve();
    const before = output.buffer.split("Resume a session").length - 1;
    output.columns = 60;
    output.emit("resize");
    const after = output.buffer.split("Resume a session").length - 1;
    expect(after).toBe(before + 1);
    type(input, "q");
    await picked;
    // The listener is removed when the picker closes.
    expect(output.listenerCount("resize")).toBe(1); // only the controller's own
    controller.dispose();
  });
});

describe("session picker without a TTY", () => {
  it("prints sessions in non-interactive mode and returns the latest", async () => {
    let output = "";
    const sessions = [
      { sessionId: "a", updatedAt: "2026", model: "m", title: "first" },
      { sessionId: "b", updatedAt: "2025", model: "m", title: "second" }
    ];

    const picked = await pickSession({
      sessions,
      input: { isTTY: false },
      output: { isTTY: false, write: (value) => { output += value; } }
    });

    expect(picked.sessionId).toBe("a");
    expect(output).toContain("a  2026  m  first");
  });

  it("prints choices", () => {
    let output = "";
    printSessionChoices({
      sessions: [{ sessionId: "a", updatedAt: "2026", model: "m", title: "first" }],
      output: { write: (value) => { output += value; } }
    });
    expect(output).toBe("a  2026  m  first\n");
  });
});
