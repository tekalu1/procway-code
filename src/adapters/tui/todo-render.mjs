/**
 * The agent's todo list on the live feed.
 *
 * Two forms on purpose (P3b-1):
 *  - `renderTodoSummary` — the one-line `[2/5] in progress: <activeForm>` ping
 *    written on every `todos.updated` DURING a turn. Re-printing the whole
 *    checklist on each update would bury the assistant's prose.
 *  - `renderTodos` (command-render.mjs) — the full checklist `/todos` prints
 *    on demand, which is where the JSON dump used to be.
 */

import { style } from "./ansi.mjs";
import { sanitizeInline } from "./sanitize.mjs";

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

export function attachTodoRenderer({ session, output, colorize = false }) {
  if (!session?.events || !output || typeof output.write !== "function") return { dispose: () => {} };
  const handler = (event) => {
    if (event?.type !== "todos.updated") return;
    const summary = renderTodoSummary(event.todos);
    if (summary) {
      const line = colorize ? style("muted", summary) : summary;
      try { output.write(`\n${line}\n`); } catch { /* ignore */ }
    }
  };
  session.events.on("todos.updated", handler);
  return {
    dispose() {
      try { session.events.off("todos.updated", handler); } catch { /* ignore */ }
    }
  };
}
