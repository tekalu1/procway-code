import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChildAgentManager } from "../src/agent/child-agent.mjs";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "procway-fork-"));
  return dir;
}

describe("createChildAgentManager — fork isolation", () => {
  it("dispatches to a forked child via child_process.fork when isolation=fork", async () => {
    const cwd = makeWorkspace();
    const workerEntry = path.join(cwd, "worker.mjs");
    writeFileSync(workerEntry, [
      "process.on('message', (msg) => {",
      "  if (msg && msg.kind === 'run') {",
      "    process.send({ kind: 'done', text: `forked:${msg.task}`, exitCode: 0, sessionId: 'forked-session' });",
      "    process.disconnect && process.disconnect();",
      "  }",
      "});"
    ].join("\n"), "utf8");

    const manager = createChildAgentManager({
      cwd,
      settings: { agents: { maxDepth: 2, maxConcurrentAgents: 1, isolation: "fork" } },
      runAgentImpl: async () => { throw new Error("inline path should not be invoked when isolation=fork"); },
      workerEntry
    });

    try {
      const result = await manager.run({ task: "hello", depth: 0 });
      expect(result.text).toBe("forked:hello");
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("forked-session");
      expect(result.depth).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("propagates worker-reported failures as rejected promises", async () => {
    const cwd = makeWorkspace();
    const workerEntry = path.join(cwd, "worker-fail.mjs");
    writeFileSync(workerEntry, [
      "process.on('message', () => {",
      "  process.send({ kind: 'failed', error: { message: 'kaboom' } });",
      "  process.disconnect && process.disconnect();",
      "});"
    ].join("\n"), "utf8");

    const manager = createChildAgentManager({
      cwd,
      settings: { agents: { maxDepth: 2, maxConcurrentAgents: 1, isolation: "fork" } },
      runAgentImpl: async () => { throw new Error("inline path should not be invoked"); },
      workerEntry
    });

    try {
      await expect(manager.run({ task: "boom", depth: 0 })).rejects.toThrow(/kaboom/);
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("uses inline runAgentImpl when isolation is left at the default 'inline'", async () => {
    const cwd = makeWorkspace();
    const manager = createChildAgentManager({
      cwd,
      settings: { agents: { maxDepth: 2, maxConcurrentAgents: 1 } },
      runAgentImpl: async ({ prompt, depth }) => ({ text: `inline:${prompt}:${depth}`, exitCode: 0 })
    });

    try {
      const result = await manager.run({ task: "bar", depth: 0 });
      expect(result.text).toBe("inline:bar:1");
      expect(result.depth).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
