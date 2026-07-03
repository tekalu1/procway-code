import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession } from "../src/core/index.mjs";

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

const DIRECTIVE = "この会話は Slack から行われています (channel: C123, thread_ts: 1.2)。";

function systemText(session) {
  const sys = session.messages.find((m) => m.role === "system");
  return sys.content.find((c) => c.kind === "text").text;
}

function countDirectives(text) {
  return text.split("## Caller Directive (highest priority)").length - 1;
}

let cwd;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-sysappend-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runTurn systemPromptAppend", () => {
  it("folds the directive into the system message once across turns", async () => {
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd });
    await session.runTurn("hello", { systemPromptAppend: DIRECTIVE });
    expect(systemText(session)).toContain(DIRECTIVE);
    expect(countDirectives(systemText(session))).toBe(1);

    await session.runTurn("again", { systemPromptAppend: DIRECTIVE });
    expect(countDirectives(systemText(session))).toBe(1);
  });

  it("does not re-append after a restore-like reset of the applied flag", async () => {
    // A session restored in a fresh process (Pod restart) keeps the directive
    // in its persisted system message while systemPromptAppendApplied resets
    // to false — the guard must detect the existing block instead of stacking.
    const session = await createAgentSession({ settings: settingsForCliAgent(), cwd });
    await session.runTurn("hello", { systemPromptAppend: DIRECTIVE });
    expect(countDirectives(systemText(session))).toBe(1);

    session.systemPromptAppendApplied = false;
    await session.runTurn("after restore", { systemPromptAppend: DIRECTIVE });
    expect(countDirectives(systemText(session))).toBe(1);
  });
});
