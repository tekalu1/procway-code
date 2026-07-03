import { randomUUID } from "node:crypto";
import { createEvent } from "../core/events/types.mjs";

/**
 * In-memory store for the LLM's TodoWrite list. The store is replace-only —
 * each `set()` swaps in the full new list (matching Claude Code's TodoWrite
 * semantics). Updates emit a `todos.updated` event on the session bus.
 */
export class TodoStore {
  constructor({ session } = {}) {
    this.session = session;
    /** @type {Array<{ id: string, content: string, status: string, activeForm: string }>} */
    this.todos = [];
  }

  list() {
    return this.todos.slice();
  }

  set(rawTodos) {
    if (!Array.isArray(rawTodos)) {
      throw new TypeError("TodoStore.set: todos must be an array");
    }
    const normalized = rawTodos.map((todo) => normalize(todo));
    this.todos = normalized;
    if (this.session?.events) {
      this.session.events.emit(createEvent("todos.updated", {
        sessionId: this.session.sessionId,
        todos: normalized.map((todo) => ({ ...todo }))
      }));
    }
    return this.todos;
  }

  summary() {
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    for (const todo of this.todos) {
      if (todo.status === "pending") pending += 1;
      else if (todo.status === "in_progress") inProgress += 1;
      else if (todo.status === "completed") completed += 1;
    }
    return {
      total: this.todos.length,
      pending,
      inProgress,
      completed
    };
  }
}

const VALID_STATUS = new Set(["pending", "in_progress", "completed"]);

function normalize(todo) {
  if (!todo || typeof todo !== "object") {
    throw new TypeError("TodoStore: each todo must be an object");
  }
  const content = typeof todo.content === "string" && todo.content.length > 0 ? todo.content : null;
  const activeForm = typeof todo.activeForm === "string" && todo.activeForm.length > 0 ? todo.activeForm : content;
  if (!content) throw new TypeError("TodoStore: each todo requires content");
  const status = VALID_STATUS.has(todo.status) ? todo.status : "pending";
  return {
    id: typeof todo.id === "string" && todo.id.length > 0 ? todo.id : randomUUID(),
    content,
    status,
    activeForm: activeForm ?? content
  };
}
