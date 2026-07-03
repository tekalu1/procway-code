/**
 * ADR 0024 Phase 3 — load_project_env tool (effectful, values never returned).
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUserEnvManager, getUserEnvPath } from "../src/config/user-env.mjs";
import { loadProjectEnv } from "../src/tools/project-env.mjs";

let tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

const snapshot = {
  version: 1,
  vars: { tenant: { T: "t" }, projects: { alpha: { A: "a" }, beta: { SECRET_KEY: "shh", B: "b" } } },
  secretKeys: { tenant: [], projects: { beta: ["SECRET_KEY"] } }
};

async function workspaceWithManager(env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "project-env-"));
  tempDirs.push(dir);
  const target = getUserEnvPath(dir);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(snapshot));
  const mgr = createUserEnvManager({ workspaceDir: dir, env }); // registers as active manager
  await mgr.reload();
  return { dir, env };
}

describe("loadProjectEnv tool", () => {
  it("activates a project and returns key names + secret flags, never values", async () => {
    const { env } = await workspaceWithManager();
    const result = await loadProjectEnv({ project: "beta" });

    expect(result.data.ok).toBe(true);
    expect(result.data.project).toBe("beta");
    expect(result.data.keys).toEqual([
      { key: "B", isSecret: false },
      { key: "SECRET_KEY", isSecret: true },
      { key: "T", isSecret: false }
    ]);
    // applied to the live env so the next run_shell inherits it
    expect(env.SECRET_KEY).toBe("shh");
    // the secret VALUE never appears anywhere in the tool result
    expect(JSON.stringify(result)).not.toContain("shh");
  });

  it("reports an unavailable project with the available list (no throw)", async () => {
    await workspaceWithManager();
    const result = await loadProjectEnv({ project: "ghost" });
    expect(result.data.ok).toBe(false);
    expect(result.data.availableProjects).toEqual(["alpha", "beta"]);
    expect(result.data.message).toContain("alpha");
  });
});
