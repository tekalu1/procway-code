import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import { TodoStore } from "../src/todos/store.mjs";

describe("TodoStore", () => {
  it("normalizes todos and assigns ids", () => {
    const store = new TodoStore({ session: { sessionId: "s-1", events: new EventBus() } });
    const todos = store.set([
      { content: "Run tests", status: "pending", activeForm: "Running tests" },
      { content: "Write docs", status: "in_progress", activeForm: "Writing docs", id: "fixed" }
    ]);
    expect(todos).toHaveLength(2);
    expect(todos[0].id).toMatch(/[0-9a-f-]{8,}/);
    expect(todos[1].id).toBe("fixed");
    expect(store.summary()).toEqual({ total: 2, pending: 1, inProgress: 1, completed: 0 });
  });

  it("emits todos.updated events on set", () => {
    const events = new EventBus();
    const seen = [];
    events.on("todos.updated", (event) => seen.push(event));
    const store = new TodoStore({ session: { sessionId: "s-2", events } });
    store.set([{ content: "step", status: "pending", activeForm: "stepping" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].todos[0].content).toBe("step");
  });

  it("rejects malformed todos", () => {
    const store = new TodoStore({ session: { sessionId: "s-3", events: new EventBus() } });
    expect(() => store.set([{ status: "pending" }])).toThrow();
    expect(() => store.set("not array")).toThrow();
  });
});
