import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { branchCommand } from "../src/core/commands/branch.mjs";
import { createAgentSession } from "../src/core/index.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { listSessions, loadSessionState, getSessionPaths } from "../src/session/store.mjs";

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
    session: { enabled: true },
    context: { compatibilityMode: "claude" }
  };
}

let cwd;
beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "procway-branch-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("/branch command", () => {
  it("creates a branch session whose head matches the parent up to the message id", async () => {
    const events = new EventBus();
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "parent-1",
      events
    });
    await session.runTurn("hello world");
    await session.flushEventLog();
    const userMessage = session.messages.find((message) => message.role === "user");
    expect(userMessage?.id).toBeTruthy();

    const branched = [];
    events.on("session.branched", (event) => branched.push(event));

    const parentEventsBefore = await readFile(getSessionPaths({ sessionId: "parent-1" }).eventsPath, "utf8");
    const result = await branchCommand({
      session,
      args: ["from", userMessage.id],
      branchId: "abcd1234"
    });
    expect(result.ok).toBe(true);
    expect(result.branchSessionId).toMatch(/parent-1-branch-/);
    expect(existsSync(result.branchDir)).toBe(true);
    expect(branched).toHaveLength(1);
    expect(branched[0].fromMessageId).toBe(userMessage.id);

    const parentEventsAfter = await readFile(getSessionPaths({ sessionId: "parent-1" }).eventsPath, "utf8");
    expect(parentEventsAfter).toBe(parentEventsBefore);

    const branchState = await loadSessionState({ sessionId: result.branchSessionId });
    expect(branchState.messages.find((message) => message.id === userMessage.id)).toBeTruthy();
    expect(branchState.eventCount).toBe(0);
    const { sessions } = await listSessions({ cwd });
    expect(sessions.find((entry) => entry.sessionId === result.branchSessionId)).toBeTruthy();
  });

  it("returns an error response when no fromMessageId is supplied", async () => {
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "parent-2"
    });
    const result = await branchCommand({ session, args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing/i);
  });

  it("returns an error when the messageId is unknown", async () => {
    const session = await createAgentSession({
      settings: settingsForCliAgent(),
      cwd,
      sessionId: "parent-3"
    });
    await session.runTurn("hi");
    await session.flushEventLog();
    const result = await branchCommand({ session, args: ["from", "no-such-id"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
