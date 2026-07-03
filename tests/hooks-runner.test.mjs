import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/core/events/bus.mjs";
import { HookRunner } from "../src/hooks/runner.mjs";
import { createAgentSession } from "../src/core/index.mjs";

const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));

async function makeExitScript(dir, code) {
  const file = path.join(dir, `exit${code}.mjs`);
  await writeFile(file, `process.exit(${code});\n`, "utf8");
  return file;
}

function settingsForCliAgent(extra = {}) {
  return {
    defaultProvider: "echo-agent",
    defaultModel: "echo",
    approvalMode: "auto-readonly",
    agents: { defaultTimeoutMs: 5000, maxDepth: 1, maxConcurrentAgents: 1 },
    tools: { maxToolRounds: 1, maxParallelTools: 1 },
    providers: { "echo-agent": { type: "cli-agent", command: process.execPath, args: [echoBin], stdinMode: "json" } },
    mcpServers: {},
    session: { enabled: false },
    context: { compatibilityMode: "claude" },
    ...extra
  };
}

let cwd;
beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "procway-hooks-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("HookRunner", () => {
  it("runs hooks via real spawn and emits hook.executed events", async () => {
    const events = new EventBus();
    const seen = [];
    events.on("hook.executed", (event) => seen.push(event));
    const exit0 = await makeExitScript(cwd, 0);
    const runner = new HookRunner({
      session: { sessionId: "h-1", events },
      hooks: {
        preToolUse: [
          { matcher: "write_file:*", command: `"${process.execPath}" "${exit0}"` }
        ],
        postToolUse: [
          { matcher: "*", command: `"${process.execPath}" "${exit0}"` }
        ]
      }
    });
    const pre = await runner.runPreToolUse({ toolName: "write_file", args: { filePath: "x" } });
    expect(pre.blocked).toBe(false);
    const post = await runner.runPostToolUse({ toolName: "write_file", args: {}, result: { kind: "write_file", summary: "ok", data: {} }, ok: true });
    expect(post.blocked).toBe(false);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0].phase).toBe("preToolUse");
  });

  it("treats non-zero exit as blocking for preToolUse and userPromptSubmit", async () => {
    const events = new EventBus();
    const exit2 = await makeExitScript(cwd, 2);
    const exit3 = await makeExitScript(cwd, 3);
    const runner = new HookRunner({
      session: { sessionId: "h-2", events },
      hooks: {
        preToolUse: [
          { matcher: "*", command: `"${process.execPath}" "${exit2}"` }
        ],
        userPromptSubmit: [
          { command: `"${process.execPath}" "${exit3}"` }
        ]
      }
    });
    const pre = await runner.runPreToolUse({ toolName: "write_file", args: {} });
    expect(pre.blocked).toBe(true);
    expect(pre.exitCode).toBe(2);

    const submit = await runner.runUserPromptSubmit({ messageId: "m-1", prompt: "hi" });
    expect(submit.blocked).toBe(true);
    expect(submit.exitCode).toBe(3);
  });

  it("skips hooks whose matcher does not match the tool name", async () => {
    const events = new EventBus();
    const exit99 = await makeExitScript(cwd, 99);
    const runner = new HookRunner({
      session: { sessionId: "h-3", events },
      hooks: {
        preToolUse: [
          { matcher: "run_shell:*", command: `"${process.execPath}" "${exit99}"` }
        ]
      }
    });
    const pre = await runner.runPreToolUse({ toolName: "read_file", args: {} });
    expect(pre.blocked).toBe(false);
  });

  it("integrates with AgentSession to block tool execution on hook failure", async () => {
    const exit1 = await makeExitScript(cwd, 1);
    const blockerCommand = `"${process.execPath}" "${exit1}"`;
    const events = new EventBus();
    const session = await createAgentSession({
      settings: settingsForCliAgent({
        hooks: { preToolUse: [{ matcher: "read_file:*", command: blockerCommand }] }
      }),
      cwd,
      sessionId: "hook-int",
      events
    });
    const result = await session.executeSingleToolCall({ id: "tc-1", name: "read_file", args: { filePath: "README.md" } });
    expect(result.data.skipped).toBe(true);
    expect(result.data.reason).toBe("hook-blocked");
  });
});
