import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  EventBus,
  evaluatePermissions,
  ApprovalCoordinator,
  messagesFromEvents,
  transcriptFromMessages,
  usageFromEvents,
  timelineFromEvents,
  isToolResult,
  createEvent,
  isAgentEvent,
  EVENT_TYPES
} from "../src/core/index.mjs";

let cwd;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-headless-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));

function settingsForCliAgent() {
  return {
    defaultProvider: "echo-agent",
    defaultModel: "echo",
    approvalMode: "auto-readonly",
    agents: { defaultTimeoutMs: 5000, maxDepth: 1, maxConcurrentAgents: 1 },
    tools: { maxToolRounds: 1, maxParallelTools: 1 },
    providers: {
      "echo-agent": {
        type: "cli-agent",
        command: process.execPath,
        args: [echoBin],
        stdinMode: "json"
      }
    },
    mcpServers: {},
    session: { enabled: false },
    context: { compatibilityMode: "claude" }
  };
}

describe("headless API", () => {
  it("re-exports the canonical core surface", () => {
    expect(typeof EventBus).toBe("function");
    expect(typeof ApprovalCoordinator).toBe("function");
    expect(typeof evaluatePermissions).toBe("function");
    expect(typeof messagesFromEvents).toBe("function");
    expect(typeof transcriptFromMessages).toBe("function");
    expect(typeof usageFromEvents).toBe("function");
    expect(typeof timelineFromEvents).toBe("function");
    expect(typeof isToolResult).toBe("function");
    expect(typeof createEvent).toBe("function");
    expect(typeof isAgentEvent).toBe("function");
    expect(Array.isArray(EVENT_TYPES)).toBe(true);
  });

  it("createAgentSession runs a turn without touching stdin/stdout", async () => {
    const events = new EventBus();
    const completed = [];
    events.on("assistant.message.completed", (event) => completed.push(event));
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "headless-1",
      events
    });
    await session.runTurn("hello world");
    await session.flushEventLog();
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const last = completed[completed.length - 1];
    const text = last.content
      .filter((b) => b?.kind === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toContain("hello world");
  });

  it("emits user.prompt + assistant.message + turn.completed without I/O", async () => {
    const events = new EventBus();
    const seen = [];
    events.on("*", (event) => seen.push(event.type));
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "headless-2",
      events
    });
    await session.runTurn("hi");
    expect(seen).toContain("user.prompt.submitted");
    expect(seen).toContain("assistant.message.completed");
    expect(seen).toContain("turn.completed");
    expect(seen).toContain("usage.recorded");
  });
});
