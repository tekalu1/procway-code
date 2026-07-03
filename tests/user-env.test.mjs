/**
 * Unit tests for the dashboard-distributed user-env snapshot applier
 * (issue #30 hot-reload): apply / update / delete tracking, project-bucket
 * merge via PROCWAY_SESSION_PROJECT, reserved-key filtering, and corrupt-file
 * fail-safety.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUserEnvManager,
  getUserEnvPath,
  getActiveProjectPath,
  readActiveProject,
  writeActiveProject,
  isReservedUserEnvKey,
  mergeUserEnvScopes,
  summarizeAvailableEnv,
  getUserEnvSummary,
  setActiveProject,
  getAvailableProjects
} from "../src/config/user-env.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeWorkspace(snapshot) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "user-env-"));
  tempDirs.push(dir);
  if (snapshot !== undefined) {
    const target = getUserEnvPath(dir);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot));
  }
  return dir;
}

describe("summarizeAvailableEnv (ADR 0024)", () => {
  const snapshot = {
    vars: {
      tenant: { A: "tenant-a", TOKEN: "secret-tok" },
      projects: { web: { B: "web-b", TOKEN: "proj-tok" } }
    },
    secretKeys: { tenant: ["TOKEN"], projects: { web: ["TOKEN"] } }
  };

  it("lists tenant + active project keys (project overrides), key-sorted, with secret flags", () => {
    expect(summarizeAvailableEnv(snapshot, { project: "web" })).toEqual([
      { key: "A", isSecret: false },
      { key: "B", isSecret: false },
      { key: "TOKEN", isSecret: true }
    ]);
  });

  it("lists tenant only when no active project", () => {
    expect(summarizeAvailableEnv(snapshot, { project: null })).toEqual([
      { key: "A", isSecret: false },
      { key: "TOKEN", isSecret: true }
    ]);
  });

  it("never surfaces values, only key names + secret flags", () => {
    const out = summarizeAvailableEnv(snapshot, { project: "web" });
    expect(JSON.stringify(out)).not.toContain("secret-tok");
    expect(JSON.stringify(out)).not.toContain("proj-tok");
  });

  it("tolerates a missing / empty snapshot", () => {
    expect(summarizeAvailableEnv(null, { project: "web" })).toEqual([]);
    expect(summarizeAvailableEnv({}, {})).toEqual([]);
  });
});

describe("getUserEnvSummary via reload (ADR 0024)", () => {
  it("reflects the snapshot's keys + secret flags for the active project after reload", async () => {
    const dir = await makeWorkspace({
      version: 1,
      vars: { tenant: { A: "a" }, projects: { web: { S: "shh" } } },
      secretKeys: { tenant: [], projects: { web: ["S"] } }
    });
    const env = { PROCWAY_SESSION_PROJECT: "web" };
    const mgr = createUserEnvManager({ workspaceDir: dir, env });
    await mgr.reload();
    expect(getUserEnvSummary()).toEqual([
      { key: "A", isSecret: false },
      { key: "S", isSecret: true }
    ]);
  });
});

describe("active-project marker (ADR 0024 Phase 2)", () => {
  it("readActiveProject: marker wins, else PROCWAY_SESSION_PROJECT, else null", async () => {
    const dir = await makeWorkspace();
    expect(getActiveProjectPath(dir)).toBe(path.join(dir, ".procway", "ai-agent", "active-project"));
    // neither marker nor env
    expect(readActiveProject(dir, {})).toBeNull();
    // env fallback (no marker)
    expect(readActiveProject(dir, { PROCWAY_SESSION_PROJECT: "envproj" })).toBe("envproj");
    // marker overrides env
    writeActiveProject(dir, "markerproj");
    expect(readActiveProject(dir, { PROCWAY_SESSION_PROJECT: "envproj" })).toBe("markerproj");
    // clearing the marker falls back to env
    writeActiveProject(dir, null);
    expect(readActiveProject(dir, { PROCWAY_SESSION_PROJECT: "envproj" })).toBe("envproj");
    // an empty / whitespace marker is treated as absent
    writeActiveProject(dir, "   ");
    expect(readActiveProject(dir, { PROCWAY_SESSION_PROJECT: "envproj" })).toBe("envproj");
  });

  const snapshot = {
    version: 1,
    vars: { tenant: { T: "t" }, projects: { alpha: { A: "a-val" }, beta: { B: "b-val" } } },
    secretKeys: { tenant: [], projects: {} }
  };

  it("the marker overrides the spawn-time PROCWAY_SESSION_PROJECT on reload", async () => {
    const dir = await makeWorkspace(snapshot);
    writeActiveProject(dir, "beta");
    const env = { PROCWAY_SESSION_PROJECT: "alpha" }; // spawn-time = alpha
    const mgr = createUserEnvManager({ workspaceDir: dir, env });
    await mgr.reload();
    expect(env.B).toBe("b-val"); // beta bucket applied (marker wins)
    expect(env.A).toBeUndefined(); // alpha bucket NOT applied
    expect(env.T).toBe("t"); // tenant always applies
  });

  it("switching the marker at runtime swaps the applied project bucket", async () => {
    const dir = await makeWorkspace(snapshot);
    const env = {}; // no spawn-time project
    const mgr = createUserEnvManager({ workspaceDir: dir, env });

    writeActiveProject(dir, "alpha");
    await mgr.reload();
    expect(env.A).toBe("a-val");
    expect(env.B).toBeUndefined();

    // runtime switch alpha → beta (what the Phase 3 MCP / a driver does)
    writeActiveProject(dir, "beta");
    const result = await mgr.reload();
    expect(env.A).toBeUndefined(); // alpha's key removed
    expect(env.B).toBe("b-val"); // beta's key added
    expect(env.T).toBe("t"); // tenant unaffected
    expect(result.removed).toContain("A");
    expect(result.applied).toContain("B");
  });

  it("getUserEnvSummary reflects the marker-selected project", async () => {
    const dir = await makeWorkspace(snapshot);
    const env = {};
    const mgr = createUserEnvManager({ workspaceDir: dir, env });
    writeActiveProject(dir, "beta");
    await mgr.reload();
    expect(getUserEnvSummary().map((e) => e.key).sort()).toEqual(["B", "T"]);
  });
});

describe("setActiveProject / getAvailableProjects (ADR 0024 Phase 3)", () => {
  const snapshot = {
    version: 1,
    vars: { tenant: { T: "t" }, projects: { alpha: { A: "a" }, beta: { B: "b" } } },
    secretKeys: { tenant: [], projects: { beta: ["B"] } }
  };

  it("lists this tenant's switchable projects after reload", async () => {
    const dir = await makeWorkspace(snapshot);
    const mgr = createUserEnvManager({ workspaceDir: dir, env: {} });
    await mgr.reload();
    expect(getAvailableProjects()).toEqual(["alpha", "beta"]);
  });

  it("writes the marker to markerDir (read-only snapshot dir stays untouched)", async () => {
    // Mirrors the Pod: snapshot lives in a read-only shared dir; the marker must
    // go to a separate WRITABLE dir.
    const snapDir = await makeWorkspace(snapshot);
    const markerDir = await mkdtemp(path.join(os.tmpdir(), "marker-"));
    tempDirs.push(markerDir);
    const env = {};
    const mgr = createUserEnvManager({ workspaceDir: snapDir, markerDir, env });
    await mgr.reload();

    await setActiveProject("beta");
    expect(env.B).toBe("b"); // applied via the marker in markerDir
    // the marker file landed in markerDir, NOT next to the snapshot
    expect(existsSync(getActiveProjectPath(markerDir))).toBe(true);
    expect(existsSync(getActiveProjectPath(snapDir))).toBe(false);
  });

  it("switches the active project, applies env, returns key NAMES only (no values)", async () => {
    const dir = await makeWorkspace(snapshot);
    const env = {};
    const mgr = createUserEnvManager({ workspaceDir: dir, env });
    await mgr.reload();

    const res = await setActiveProject("beta");
    expect(res.project).toBe("beta");
    expect(res.available).toEqual([
      { key: "B", isSecret: true },
      { key: "T", isSecret: false }
    ]);
    expect(env.B).toBe("b"); // applied to process.env (next subprocess inherits)
    expect(env.A).toBeUndefined();
    // the returned summary carries names + flags only, never values
    expect(JSON.stringify(res.available)).not.toContain('"b"');
  });

  it("rejects a project not in this tenant's snapshot (boundary)", async () => {
    const dir = await makeWorkspace(snapshot);
    const mgr = createUserEnvManager({ workspaceDir: dir, env: {} });
    await mgr.reload();
    await expect(setActiveProject("other-tenant-proj")).rejects.toMatchObject({
      code: "PROJECT_NOT_AVAILABLE"
    });
  });

  it("clearing (empty) reverts to the spawn-time PROCWAY_SESSION_PROJECT", async () => {
    const dir = await makeWorkspace(snapshot);
    const env = { PROCWAY_SESSION_PROJECT: "alpha" };
    const mgr = createUserEnvManager({ workspaceDir: dir, env });
    await mgr.reload();
    await setActiveProject("beta");
    expect(env.B).toBe("b");
    await setActiveProject("");
    expect(env.A).toBe("a"); // back to the spawn-time project alpha
    expect(env.B).toBeUndefined();
  });
});

describe("mergeUserEnvScopes", () => {
  it("merges tenant + the session's project bucket, project winning", () => {
    const { desired } = mergeUserEnvScopes(
      {
        tenant: { A: "tenant-a", B: "tenant-b" },
        projects: { web: { B: "web-b", C: "web-c" }, other: { D: "other-d" } }
      },
      { project: "web" }
    );
    expect(desired).toEqual({ A: "tenant-a", B: "web-b", C: "web-c" });
  });

  it("ignores project buckets without a session project", () => {
    const { desired } = mergeUserEnvScopes(
      { tenant: { A: "a" }, projects: { web: { B: "b" } } },
      { project: null }
    );
    expect(desired).toEqual({ A: "a" });
  });

  it("drops reserved and invalid keys", () => {
    const { desired, skipped } = mergeUserEnvScopes(
      {
        tenant: {
          OK: "1",
          PROCWAY_SERVE_TOKEN: "stolen",
          GH_TOKEN: "stolen",
          "BAD-NAME": "x",
          NUM: 42
        }
      },
      {}
    );
    expect(desired).toEqual({ OK: "1" });
    expect(skipped).toContain("PROCWAY_SERVE_TOKEN");
    expect(skipped).toContain("GH_TOKEN");
    expect(skipped).toContain("BAD-NAME");
  });
});

describe("isReservedUserEnvKey", () => {
  it("reserves PROCWAY_* and the runtime wiring names", () => {
    expect(isReservedUserEnvKey("PROCWAY_ANYTHING")).toBe(true);
    expect(isReservedUserEnvKey("HTTP_PROXY")).toBe(true);
    expect(isReservedUserEnvKey("AGENT_BROWSER_ARGS")).toBe(true);
    expect(isReservedUserEnvKey("MY_API_KEY")).toBe(false);
  });
});

describe("createUserEnvManager", () => {
  it("applies snapshot vars to env and updates them on reload", async () => {
    const dir = await makeWorkspace({ version: 1, vars: { tenant: { FOO: "v1" } } });
    const env = {};
    const manager = createUserEnvManager({ workspaceDir: dir, env });

    let result = await manager.reload();
    expect(env.FOO).toBe("v1");
    expect(result.applied).toEqual(["FOO"]);

    await writeFile(manager.path, JSON.stringify({ version: 1, vars: { tenant: { FOO: "v2" } } }));
    result = await manager.reload();
    expect(env.FOO).toBe("v2");
    expect(result.applied).toEqual(["FOO"]);
  });

  it("deletes previously applied keys that disappear from the snapshot", async () => {
    const dir = await makeWorkspace({ version: 1, vars: { tenant: { FOO: "x", BAR: "y" } } });
    const env = { PRE_EXISTING: "untouched" };
    const manager = createUserEnvManager({ workspaceDir: dir, env });

    await manager.reload();
    expect(env.FOO).toBe("x");
    expect(env.BAR).toBe("y");

    await writeFile(manager.path, JSON.stringify({ version: 1, vars: { tenant: { FOO: "x" } } }));
    const result = await manager.reload();
    expect("BAR" in env).toBe(false);
    expect(result.removed).toEqual(["BAR"]);
    // Keys the manager never set are never deleted.
    expect(env.PRE_EXISTING).toBe("untouched");
  });

  it("merges the session's own project bucket (PROCWAY_SESSION_PROJECT)", async () => {
    const dir = await makeWorkspace({
      version: 1,
      vars: { tenant: { KEY: "tenant" }, projects: { web: { KEY: "web", ONLY: "web-only" } } }
    });
    const env = { PROCWAY_SESSION_PROJECT: "web" };
    const manager = createUserEnvManager({ workspaceDir: dir, env });

    await manager.reload();
    expect(env.KEY).toBe("web");
    expect(env.ONLY).toBe("web-only");
  });

  it("missing snapshot file removes everything previously applied", async () => {
    const dir = await makeWorkspace({ version: 1, vars: { tenant: { FOO: "x" } } });
    const env = {};
    const manager = createUserEnvManager({ workspaceDir: dir, env });
    await manager.reload();
    expect(env.FOO).toBe("x");

    await rm(manager.path);
    const result = await manager.reload();
    expect("FOO" in env).toBe(false);
    expect(result.removed).toEqual(["FOO"]);
  });

  it("keeps previous values and warns on corrupt JSON (torn write)", async () => {
    const dir = await makeWorkspace({ version: 1, vars: { tenant: { FOO: "x" } } });
    const env = {};
    const onWarn = vi.fn();
    const manager = createUserEnvManager({ workspaceDir: dir, env, onWarn });
    await manager.reload();
    expect(env.FOO).toBe("x");

    await writeFile(manager.path, "{ definitely not json");
    const result = await manager.reload();
    expect(result).toBeNull();
    expect(env.FOO).toBe("x");
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("STALE"));
  });

  it("never applies reserved keys from a (hand-edited) snapshot", async () => {
    const dir = await makeWorkspace({
      version: 1,
      vars: { tenant: { PROCWAY_PROXY_TOKEN: "stolen", SAFE: "ok" } }
    });
    const env = { PROCWAY_PROXY_TOKEN: "real" };
    const onWarn = vi.fn();
    const manager = createUserEnvManager({ workspaceDir: dir, env, onWarn });

    const result = await manager.reload();
    expect(env.PROCWAY_PROXY_TOKEN).toBe("real");
    expect(env.SAFE).toBe("ok");
    expect(result.skipped).toContain("PROCWAY_PROXY_TOKEN");
    expect(onWarn).toHaveBeenCalled();
  });
});
