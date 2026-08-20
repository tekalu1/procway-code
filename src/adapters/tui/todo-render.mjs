/**
 * The agent's todo list on the live feed.
 *
 * Three forms (P3b-1 + this change):
 *  - `renderTodoSummary` — the one-line `[2/5] in progress: <activeForm>` ping
 *    used in "compact" mode. Re-printing the whole checklist on each update
 *    would bury the assistant's prose, so compact mode keeps to one line.
 *  - `renderTodoPanel` — the full `▌TODO` checklist (`renderChecklist`) used in
 *    "full" mode (default). Shows every item with its status glyph plus a
 *    `done/total · in progress: X` status line.
 *  - `renderTodos` (command-render.mjs) — the same full checklist `/todos`
 *    prints on demand.
 *
 * `attachTodoRenderer` owns the live subscription. Two things it does beyond
 * the original one-line summary:
 *   1. It renders the CURRENT persisted list on attach, fixing the timing gap
 *      where `AgentSession.initialize()` re-announces a restored todo list
 *      (via `todos.updated`) BEFORE the TUI subscribes — so at session start /
 *      `/resume` / `/checkout` the restored list was never shown. This mirrors
 *      the serve adapter's `replayTodos` (adapters/serve/bridge.mjs). All
 *      resume/checkout paths funnel through `createReplSession`, so replaying
 *      here covers them at once.
 *   2. It re-renders the current list at the start of each turn
 *      (`user.prompt.submitted`), so the list stays pinned near the bottom of
 *      the feed while interacting — a scrollback-friendly "always visible"
 *      TODO panel.
 *
 * Modes: "full" (term: settings.ui.todoDisplay === "full", the default),
 * "compact" (one-line summary) and "off". `setMode` lets `/todos full|compact|off`
 * toggle it at runtime; `rerender` re-emits it immediately.
 */

import { sanitizeInline } from "./sanitize.mjs";
import { renderChecklist } from "./panel.mjs";

export function renderTodoSummary(todos = []) {
  if (!Array.isArray(todos) || todos.length === 0) return "";
  const total = todos.length;
  let inProgressIndex = -1;
  let completed = 0;
  for (let i = 0; i < todos.length; i += 1) {
    const status = todos[i]?.status;
    if (status === "completed") completed += 1;
    if (inProgressIndex === -1 && status === "in_progress") inProgressIndex = i;
  }
  const cursor = inProgressIndex >= 0 ? inProgressIndex + 1 : completed;
  // `activeForm` is free text the model wrote into `todo_write`, and this line
  // is printed mid-turn between streamed blocks.
  const active = inProgressIndex >= 0 ? sanitizeInline(todos[inProgressIndex]?.activeForm) : "";
  const phase = inProgressIndex >= 0
    ? `in progress: ${active}`
    : completed === total ? "complete" : "ready";
  return `[${cursor}/${total}] ${phase}`;
}

/**
 * Full TODO checklist + status, e.g.
 *   ▌ TODO  2/3 done · in progress: Implementing
 *      ✔ Read brief
 *      ▸ Implementing
 *      ○ Write tests
 */
export function renderTodoPanel(todos = [], { width = 80, color = true } = {}) {
  const list = Array.isArray(todos) ? todos : [];
  const done = list.filter((todo) => todo?.status === "completed").length;
  const total = list.length;
  const inProgress = list.find((todo) => todo?.status === "in_progress");
  const active = inProgress ? (inProgress?.activeForm || inProgress?.content || "") : "";
  let subtitle = total > 0 ? `${done}/${total} done` : null;
  if (inProgress) {
    const tail = `in progress: ${sanitizeInline(active)}`;
    subtitle = subtitle ? `${subtitle} · ${tail}` : tail;
  }
  return renderChecklist({
    title: "TODO",
    subtitle,
    items: list.map((todo) => ({
      status: todo?.status,
      text: todo?.status === "in_progress"
        ? (todo?.activeForm || todo?.content || "")
        : (todo?.content ?? "")
    })),
    width,
    color
  });
}

export function attachTodoRenderer({ session, output, colorize = false, width = 80, mode = "full" }) {
  if (!session?.events || !output || typeof output.write !== "function") {
    return { dispose: () => {}, setMode: () => {}, rerender: () => {} };
  }
  const events = session.events;
  let currentMode = mode === "off" || mode === "compact" ? mode : "full";

  const render = (todos) => {
    if (currentMode === "off") return "";
    if (currentMode === "compact") return renderTodoSummary(todos);
    return renderTodoPanel(todos, { width, color: colorize });
  };

  const writeBlock = (todos) => {
    const block = render(todos);
    // With the persistent input dock the panel is a pinned region drawn
    // directly above the prompt (always at the bottom of the screen), so it
    // never scrolls away mid-turn. On a plain sink it falls back to the
    // original scrollback line re-shown at each turn.
    if (typeof output.setDockPanel === "function") {
      output.setDockPanel(block || null);
      return;
    }
    if (!block) return;
    try { output.write(`\n${block}`); } catch { /* ignore */ }
  };

  const onTodos = (event) => {
    if (event?.type !== "todos.updated") return;
    writeBlock(event.todos);
  };

  // Keep the list pinned near the bottom while working: at the start of every
  // turn, re-show the current list (if any) so it never scrolls out of reach.
  const onPrompt = (event) => {
    if (event?.type !== "user.prompt.submitted") return;
    const current = typeof session.todoStore?.list === "function" ? session.todoStore.list() : [];
    if (current.length > 0) writeBlock(current);
  };

  events.on("todos.updated", onTodos);
  events.on("user.prompt.submitted", onPrompt);

  // Replay the persisted list on attach (start / resume / checkout). The
  // bridge re-announces it, but that fires during initialize(), before this
  // renderer subscribes — so emit the current state here.
  const existing = typeof session.todoStore?.list === "function" ? session.todoStore.list() : [];
  if (existing.length > 0) writeBlock(existing);

  return {
    dispose() {
      try { events.off("todos.updated", onTodos); } catch { /* ignore */ }
      try { events.off("user.prompt.submitted", onPrompt); } catch { /* ignore */ }
    },
    setMode(next) {
      if (next === "full" || next === "compact" || next === "off") currentMode = next;
    },
    rerender() {
      const current = typeof session.todoStore?.list === "function" ? session.todoStore.list() : [];
      writeBlock(current);
    }
  };
}
