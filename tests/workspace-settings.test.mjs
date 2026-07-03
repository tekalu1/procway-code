import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceSettings, setWorkspaceSetting } from "../src/config/workspace-settings.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("workspace settings", () => {
  it("sets nested config values", async () => {
    const cwd = await makeWorkspace();
    await setWorkspaceSetting({ cwd, key: "context.compatibilityMode", value: "codex" });
    await setWorkspaceSetting({ cwd, key: "tools.maxParallelTools", value: "3" });
    await setWorkspaceSetting({ cwd, key: "tools.maxToolRounds", value: "0" });

    await expect(readWorkspaceSettings(cwd)).resolves.toEqual({
      context: { compatibilityMode: "codex" },
      tools: { maxParallelTools: 3, maxToolRounds: 0 }
    });
  });
});

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
  tempDirs.push(dir);
  return dir;
}
