import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import {
  renderTodoPanel,
  attachTodoRenderer
} from "../src/adapters/tui/todo-render.mjs";

const SAMPLE = [
  { id: "a", content: "Read brief", status: "completed", activeForm: "" },
  { id: "b", content: "Implement", status: "in_progress", activeForm: "Implementing" },
  { id: "c", content: "Write tests", status: "pending", activeForm: "" }
];

function makeSession({ todos = [] } = {}) {
  const events = new EventBus();
  return {
    sessionId: "s",
    events,
    todoStore: {
      list: () => todos.map((todo) => ({ ...todo }))
    }
  };
}

function attach(session, opts = {}) {
  let captured = "";
  const writer = { write: (t) => { captured += t; } };
  const handle = attachTodoRenderer({ session, output: writer, colorize: false, ...opts });
  return { text: () => captured, clear: () => { captured = ""; }, writer, handle };
}

describe("renderTodoPanel", () => {
  it("renders a checklist with status glyphs + subtitle", () => {
    const out = renderTodoPanel(SAMPLE, { width: 60, color: false });
    expect(out).toContain("TODO");
    expect(out).toContain("1/3 done · in progress: Implementing");
    expect(out).toContain("✔");
    expect(out).toContain("▸");
    expect(out).toContain("○");
    expect(out).toContain("Read brief");
    expect(out).toContain("Implementing"); // in_progress item shows activeForm
    expect(out).toContain("Write tests");
  });

  it("shows an empty-state marker when there are no todos", () => {
    const out = renderTodoPanel([], { width: 60, color: false });
    expect(out).toContain("TODO");
    expect(out).toContain("(no todos)");
  });
});

describe("attachTodoRenderer (full mode default)", () => {
  it("writes the full panel on todos.updated", () => {
    const session = makeSession();
    const { text, handle } = attach(session);
    session.events.emit({ type: "todos.updated", todos: SAMPLE });
    expect(text()).toContain("TODO");
    expect(text()).toContain("▸ Implementing");
    handle.dispose();
  });

  it("replays the persisted list on attach (start / resume / checkout bug)", () => {
    const session = makeSession({ todos: SAMPLE });
    const { text, handle } = attach(session);
    // No todos.updated needed — the current list is rendered at attach time.
    expect(text()).toContain("TODO");
    expect(text()).toContain("in progress: Implementing");
    handle.dispose();
  });

  it("re-renders the current list at the start of each turn", () => {
    const session = makeSession({ todos: SAMPLE });
    const { text, clear, handle } = attach(session);
    clear(); // discard the attach replay
    session.events.emit({ type: "user.prompt.submitted", sessionId: "s", messageId: "m" });
    expect(text()).toContain("TODO");
    expect(text()).toContain("▸ Implementing");
    handle.dispose();
  });

  it("does not write anything when there are no todos and nothing changes", () => {
    const session = makeSession();
    const { text, handle } = attach(session);
    expect(text()).toBe("");
    handle.dispose();
  });
});

describe("attachTodoRenderer (compact / off modes)", () => {
  it("writes a one-line summary in compact mode", () => {
    const session = makeSession({ todos: SAMPLE });
    const { text, handle } = attach(session, { mode: "compact" });
    expect(text()).toContain("[2/3] in progress: Implementing");
    expect(text()).not.toContain("TODO");
    handle.dispose();
  });

  it("writes nothing in off mode", () => {
    const session = makeSession({ todos: SAMPLE });
    const { text, handle } = attach(session, { mode: "off" });
    expect(text()).toBe("");
    handle.dispose();
  });

  it("setMode switches live output and rerender() re-emits current state", () => {
    const session = makeSession({ todos: SAMPLE });
    const { text, clear, handle } = attach(session);
    clear(); // discard attach replay (full panel)
    handle.setMode("compact");
    handle.rerender();
    expect(text()).toContain("[2/3] in progress: Implementing");
    handle.setMode("full");
    handle.rerender();
    expect(text()).toContain("▸ Implementing");
    handle.dispose();
  });
});

describe("attachTodoRenderer — persistent dock (setDockPanel)", () => {
  function attachDock(session, opts = {}) {
    const calls = [];
    const writer = {
      write: () => {},
      setDockPanel: (block) => calls.push(block)
    };
    const handle = attachTodoRenderer({ session, output: writer, colorize: false, ...opts });
    return { calls, handle };
  }

  it("pins the full panel through setDockPanel instead of writing into the feed", () => {
    const session = makeSession();
    const { calls, handle } = attachDock(session);
    session.events.emit({ type: "todos.updated", todos: SAMPLE });
    expect(calls.at(-1)).toContain("TODO");
    expect(calls.at(-1)).toContain("▸ Implementing");
    handle.dispose();
  });

  it("pins a one-line summary in compact mode and null in off mode", () => {
    const session = makeSession({ todos: SAMPLE });
    const compact = attachDock(session, { mode: "compact" });
    expect(compact.calls.at(-1)).toContain("[2/3] in progress: Implementing");
    compact.handle.dispose();
    const off = attachDock(session, { mode: "off" });
    expect(off.calls.at(-1)).toBe(null);
    off.handle.dispose();
  });

  it("re-pins the current list at the start of each turn", () => {
    const session = makeSession({ todos: SAMPLE });
    const { calls, handle } = attachDock(session);
    calls.length = 0; // discard attach replay
    session.events.emit({ type: "user.prompt.submitted", sessionId: "s", messageId: "m" });
    expect(calls.at(-1)).toContain("TODO");
    expect(calls.at(-1)).toContain("▸ Implementing");
    handle.dispose();
  });
});

describe("attachTodoRenderer dispose", () => {
  it("stops writing after dispose", () => {
    const session = makeSession({ todos: SAMPLE });
    const { text, clear, handle } = attach(session);
    clear(); // discard attach replay
    handle.dispose();
    session.events.emit({ type: "todos.updated", todos: [] });
    expect(text()).toBe("");
  });
});
