import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/core/events/bus.mjs";
import { TodoStore } from "../src/todos/store.mjs";
import { executeToolCall } from "../src/tools/registry.mjs";

let cwd;
beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "procway-tw-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("TodoWrite tool", () => {
  it("updates the bound TodoStore and returns a ToolResult", async () => {
    const events = new EventBus();
    const store = new TodoStore({ session: { sessionId: "s-tw", events } });
    const seen = [];
    events.on("todos.updated", (event) => seen.push(event));
    const result = await executeToolCall({
      name: "TodoWrite",
      args: {
        todos: [
          { content: "Read brief", status: "completed", activeForm: "Reading brief" },
          { content: "Implement feature", status: "in_progress", activeForm: "Implementing feature" }
        ]
      },
      cwd,
      settings: { approvalMode: "auto-readonly" },
      todoStore: store
    });
    expect(result.kind).toBe("run_shell");
    expect(result.data.todos).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(store.summary()).toEqual({ total: 2, pending: 0, inProgress: 1, completed: 1 });
  });

  it("returns a skipped result when no store is wired", async () => {
    const result = await executeToolCall({
      name: "TodoWrite",
      args: { todos: [] },
      cwd,
      settings: { approvalMode: "auto-readonly" }
    });
    expect(result.data.skipped).toBe(true);
  });
});
