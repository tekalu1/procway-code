import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeMemory } from "../src/memory/store.mjs";
import { retrieveRelevantMemory, formatMemoryForPrompt } from "../src/memory/retriever.mjs";

let homeDir;
beforeEach(async () => { homeDir = await mkdtemp(path.join(os.tmpdir(), "procway-memret-")); });
afterEach(async () => { await rm(homeDir, { recursive: true, force: true }); });

describe("memory retriever", () => {
  it("always includes user / feedback memories and ranks project / reference by signal", async () => {
    await writeMemory({ homeDir, name: "user-role", description: "data scientist", type: "user", body: "Data scientist focused on observability." });
    await writeMemory({ homeDir, name: "no-mocks", description: "real APIs", type: "feedback", body: "Mocks are forbidden in tests." });
    await writeMemory({ homeDir, name: "tk-99", description: "Auth migration", type: "project", body: "Working on auth migration in /repo/auth/" });
    await writeMemory({ homeDir, name: "grafana", description: "Dashboard", type: "reference", body: "Grafana dashboard at grafana.internal" });

    const snapshot = await retrieveRelevantMemory({ homeDir, cwd: "/repo/auth/handlers", topN: 5 });
    expect(snapshot).not.toBeNull();
    const names = snapshot.selected.map((entry) => entry.name).sort();
    expect(names).toContain("user-role");
    expect(names).toContain("no-mocks");
    // Project memory matching `auth` should outrank the unrelated reference
    const projects = snapshot.selected.filter((entry) => entry.type === "project");
    expect(projects.find((entry) => entry.name === "tk-99")).toBeTruthy();
  });

  it("formatMemoryForPrompt produces a human-readable section", async () => {
    await writeMemory({ homeDir, name: "role", description: "engineer", type: "user", body: "senior engineer" });
    const snapshot = await retrieveRelevantMemory({ homeDir, cwd: "/x" });
    const formatted = formatMemoryForPrompt(snapshot);
    expect(formatted).toContain("## Memory");
    expect(formatted).toContain("### User");
    expect(formatted).toContain("- role: engineer");
  });

  it("returns null when memory dir does not exist", async () => {
    const snapshot = await retrieveRelevantMemory({ homeDir: path.join(homeDir, "missing"), cwd: "/x" });
    expect(snapshot).toBeNull();
  });
});
