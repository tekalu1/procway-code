import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { createAgentSession } from "../src/core/index.mjs";
import { PlanMode, buildDeferredToolResult } from "../src/agent/plan-mode.mjs";
import { planCommand } from "../src/core/commands/plan.mjs";

const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));

function settingsForCliAgent() {
  return {
    defaultProvider: "echo-agent",
    defaultModel: "echo",
    approvalMode: "auto-readonly",
    agents: { defaultTimeoutMs: 5000, maxDepth: 1, maxConcurrentAgents: 1 },
    tools: { maxToolRounds: 1, maxParallelTools: 1 },
    providers: { "echo-agent": { type: "cli-agent", command: process.execPath, args: [echoBin], stdinMode: "json" } },
    mcpServers: {},
    session: { enabled: false },
    context: { compatibilityMode: "claude" }
  };
}

let cwd;
beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "procway-plan-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("PlanMode state machine", () => {
  it("toggles active state and clears the queue when disabled", () => {
    const session = { sessionId: "p-1", events: { emit: () => {} } };
    const planMode = new PlanMode({ session });
    expect(planMode.isActive()).toBe(false);
    planMode.toggle();
    expect(planMode.isActive()).toBe(true);
    planMode.enqueue({ name: "write_file", args: {}, summary: "x.md" });
    expect(planMode.hasPending()).toBe(true);
    planMode.toggle();
    expect(planMode.isActive()).toBe(false);
    expect(planMode.hasPending()).toBe(false);
  });

  it("emits plan.queued / plan.applied / plan.discarded events", async () => {
    const events = new EventBus();
    const seen = [];
    events.on("*", (event) => {
      if (event.type.startsWith("plan.")) seen.push(event);
    });
    const session = { sessionId: "p-2", events };
    const planMode = new PlanMode({ session, active: true });
    planMode.enqueue({ name: "write_file", args: { filePath: "a.md" }, summary: "a.md" });
    planMode.enqueue({ name: "Edit", args: { filePath: "b.md" }, summary: "b.md" });
    expect(seen.filter((e) => e.type === "plan.queued")).toHaveLength(2);

    const applied = await planMode.apply({ executeImpl: async (entry) => entry });
    expect(applied).toHaveLength(2);
    expect(seen.find((e) => e.type === "plan.applied").entryIds).toHaveLength(2);

    planMode.enqueue({ name: "run_shell", args: { command: "ls" }, summary: "ls" });
    planMode.discard("user-rejected");
    expect(seen.find((e) => e.type === "plan.discarded")).toBeTruthy();
  });

  it("buildDeferredToolResult returns a valid ToolResult kind for each known tool", () => {
    expect(buildDeferredToolResult({ name: "write_file", summary: "x.md" }).kind).toBe("write_file");
    expect(buildDeferredToolResult({ name: "Edit", summary: "x.md" }).kind).toBe("edit");
    expect(buildDeferredToolResult({ name: "apply_patch", summary: "patch" }).kind).toBe("apply_patch");
    expect(buildDeferredToolResult({ name: "run_shell", summary: "ls" }).kind).toBe("run_shell");
    expect(buildDeferredToolResult({ name: "spawn_agent", summary: "task" }).kind).toBe("spawn_agent");
    expect(buildDeferredToolResult({ name: "mcp__foo__bar", summary: "x" }).kind).toBe("mcp");
  });
});

describe("planCommand", () => {
  it("toggles state via /plan", async () => {
    const planMode = new PlanMode({ session: { sessionId: "p-cmd", events: { emit: () => {} } } });
    const session = { sessionId: "p-cmd", planMode };
    const first = await planCommand({ session, args: [] });
    expect(first.active).toBe(true);
    const second = await planCommand({ session, args: [] });
    expect(second.active).toBe(false);
    const explicit = await planCommand({ session, args: ["on"] });
    expect(explicit.active).toBe(true);
  });
});

describe("AgentSession + Plan mode (integration)", () => {
  it("defers write_file calls under plan mode and emits plan.queued", async () => {
    const events = new EventBus();
    const queued = [];
    events.on("plan.queued", (event) => queued.push(event));
    const session = await createAgentSession({
      settings: { ...settingsForCliAgent(), plan: { enabled: true } },
      cwd,
      sessionId: "plan-int-1",
      events
    });
    const result = await session.executeSingleToolCall({ id: "tc-1", name: "write_file", args: { filePath: "draft.md", content: "hi" } });
    expect(result.kind).toBe("write_file");
    expect(result.data.planQueued).toBe(true);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe("write_file");
  });
});
