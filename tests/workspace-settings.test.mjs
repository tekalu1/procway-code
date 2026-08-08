import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readScopedSettings, readWorkspaceSettings, setSetting, setWorkspaceSetting } from "../src/config/workspace-settings.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("workspace settings", () => {
  it("writes to user scope by default", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeWorkspace();
    const result = await setSetting({ cwd, homeDir, key: "defaultProvider", value: "openai" });

    expect(result.scope).toBe("user");
    expect(result.path).toBe(path.join(homeDir, ".procway", "ai-agent", "settings.json"));
    await expect(readScopedSettings({ homeDir })).resolves.toEqual({ defaultProvider: "openai" });
    await expect(readWorkspaceSettings(cwd)).resolves.toEqual({});
  });

  it("supports an explicit workspace scope", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeWorkspace();
    const result = await setSetting({ cwd, homeDir, scope: "workspace", key: "approvalMode", value: "full-auto" });

    expect(result.scope).toBe("workspace");
    expect(result.path).toBe(path.join(cwd, ".procway", "ai-agent", "settings.json"));
    await expect(readWorkspaceSettings(cwd)).resolves.toEqual({ approvalMode: "full-auto" });
    await expect(readScopedSettings({ homeDir })).resolves.toEqual({});
  });

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

  it("rejects unknown scopes", async () => {
    await expect(setSetting({ scope: "project", key: "x", value: "y" }))
      .rejects.toThrow("scope must be user or workspace");
  });
});

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
  tempDirs.push(dir);
  return dir;
}
