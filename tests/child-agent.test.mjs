import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChildAgentManager } from "../src/agent/child-agent.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("createChildAgentManager", () => {
  it("runs child agents with incremented depth", async () => {
    const cwd = await makeWorkspace();
    const manager = createChildAgentManager({
      cwd,
      settings: { agents: { maxDepth: 2, maxConcurrentAgents: 1 } },
      runAgentImpl: async ({ prompt, depth }) => ({ exitCode: 0, text: `${prompt}:${depth}` })
    });

    await expect(manager.run({ task: "task", depth: 0 })).resolves.toEqual(expect.objectContaining({
      depth: 1,
      text: "task:1"
    }));
  });

  it("rejects child agents beyond maxDepth", async () => {
    const cwd = await makeWorkspace();
    const manager = createChildAgentManager({
      cwd,
      settings: { agents: { maxDepth: 1, maxConcurrentAgents: 1 } },
      runAgentImpl: async () => ({ exitCode: 0 })
    });

    await expect(manager.run({ task: "too deep", depth: 1 })).rejects.toThrow("max depth exceeded");
  });

  it("queues child agents above maxConcurrentAgents", async () => {
    const cwd = await makeWorkspace();
    let active = 0;
    let maxActive = 0;
    const manager = createChildAgentManager({
      cwd,
      settings: { agents: { maxDepth: 2, maxConcurrentAgents: 1 } },
      runAgentImpl: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { exitCode: 0 };
      }
    });

    await Promise.all([
      manager.run({ task: "a", depth: 0 }),
      manager.run({ task: "b", depth: 0 })
    ]);

    expect(maxActive).toBe(1);
  });
});

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
  tempDirs.push(dir);
  return dir;
}
