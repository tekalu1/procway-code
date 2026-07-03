import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMemoryIndex, writeMemory, getMemoryDir } from "../src/memory/store.mjs";
import { parseMemoryFile, parseFrontmatter } from "../src/memory/parser.mjs";

let homeDir;
beforeEach(async () => { homeDir = await mkdtemp(path.join(os.tmpdir(), "procway-mem-")); });
afterEach(async () => { await rm(homeDir, { recursive: true, force: true }); });

describe("memory store", () => {
  it("returns null when the directory does not exist", async () => {
    const result = await loadMemoryIndex({ homeDir });
    expect(result).toBeNull();
  });

  it("creates a memory file, type-tags it, and rebuilds MEMORY.md", async () => {
    const written = await writeMemory({
      homeDir,
      name: "no-mocks",
      description: "Tests must use real APIs",
      type: "feedback",
      body: "Mocks are forbidden. Reason: prior incident."
    });
    expect(written.action).toBe("create");
    expect(written.path.startsWith(getMemoryDir({ homeDir }))).toBe(true);

    const indexContents = await readFile(path.join(getMemoryDir({ homeDir }), "MEMORY.md"), "utf8");
    expect(indexContents).toContain("## Feedback");
    expect(indexContents).toContain("- [no-mocks](feedback_no_mocks.md)");

    const reload = await loadMemoryIndex({ homeDir });
    expect(reload?.types?.feedback).toBe(1);
    expect(reload.memories[0].body).toContain("Mocks are forbidden");
  });

  it("updates an existing memory in place", async () => {
    await writeMemory({ homeDir, name: "role", description: "user role", type: "user", body: "version 1" });
    const second = await writeMemory({ homeDir, name: "role", description: "user role", type: "user", body: "version 2" });
    expect(second.action).toBe("update");
    const reload = await loadMemoryIndex({ homeDir });
    expect(reload.memories.find((entry) => entry.name === "role").body).toContain("version 2");
  });

  it("parses memory files with type frontmatter", () => {
    const raw = "---\nname: foo\ndescription: bar\ntype: project\n---\n\nbody text";
    const parsed = parseMemoryFile(raw);
    expect(parsed.name).toBe("foo");
    expect(parsed.type).toBe("project");
    expect(parsed.body).toBe("body text");
  });

  it("handles frontmatter-less files as raw bodies", () => {
    const parsed = parseFrontmatter("plain text only\nsecond line");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("plain text only\nsecond line");
  });
});
