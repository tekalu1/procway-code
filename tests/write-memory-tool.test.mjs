import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeToolCall } from "../src/tools/registry.mjs";
import { loadMemoryIndex } from "../src/memory/store.mjs";

let homeDir;
let cwd;
beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "procway-wmt-home-"));
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-wmt-cwd-"));
});
afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("WriteMemory / ReadMemory tools", () => {
  it("WriteMemory persists the entry, gated by approval", async () => {
    const settings = { approvalMode: "full-auto", memory: { homeDir } };
    const result = await executeToolCall({
      name: "WriteMemory",
      args: {
        name: "feature-flag",
        description: "auto-approve testing",
        type: "feedback",
        body: "Approval mode = full-auto only in tests."
      },
      cwd,
      settings
    });
    expect(result.kind).toBe("write_file");
    expect(result.data.action).toBe("create");
    const reload = await loadMemoryIndex({ homeDir });
    expect(reload.types.feedback).toBe(1);
  });

  it("WriteMemory returns a skipped ToolResult when approval is denied", async () => {
    const settings = { approvalMode: "always-ask", memory: { homeDir } };
    const result = await executeToolCall({
      name: "WriteMemory",
      args: { name: "x", description: "x", type: "feedback", body: "x" },
      cwd,
      settings
    });
    expect(result.data.skipped).toBe(true);
  });

  it("ReadMemory lists existing entries", async () => {
    const settings = { approvalMode: "full-auto", memory: { homeDir } };
    await executeToolCall({
      name: "WriteMemory",
      args: { name: "policy", description: "rules", type: "user", body: "Always lower-case branch names." },
      cwd,
      settings
    });
    const result = await executeToolCall({
      name: "ReadMemory",
      args: {},
      cwd,
      settings
    });
    expect(result.kind).toBe("read_file");
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].type).toBe("user");
  });
});
