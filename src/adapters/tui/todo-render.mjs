/**
 * Render a textual progress bar for the agent's todo list. Used by the REPL
 * to show "[2/5] in progress: <activeForm>" between turns.
 */

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
  const active = inProgressIndex >= 0 ? todos[inProgressIndex]?.activeForm ?? "" : "";
  const phase = inProgressIndex >= 0
    ? `in progress: ${active}`
    : completed === total ? "complete" : "ready";
  return `[${cursor}/${total}] ${phase}`;
}

export function attachTodoRenderer({ session, output }) {
  if (!session?.events || !output || typeof output.write !== "function") return { dispose: () => {} };
  const handler = (event) => {
    if (event?.type !== "todos.updated") return;
    const summary = renderTodoSummary(event.todos);
    if (summary) {
      try { output.write(`\n${summary}\n`); } catch { /* ignore */ }
    }
  };
  session.events.on("todos.updated", handler);
  return {
    dispose() {
      try { session.events.off("todos.updated", handler); } catch { /* ignore */ }
    }
  };
}
