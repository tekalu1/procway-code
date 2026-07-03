import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyUnifiedPatch, listFiles, readTextFile, searchFiles, writeTextFile } from "../src/tools/filesystem.mjs";
import { isToolResult } from "../src/core/types/tool-result.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("filesystem tools", () => {
  it("lists, reads, and searches workspace files as ToolResult payloads", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "README.md"), "hello procway", "utf8");

    const listed = await listFiles({ cwd });
    expect(isToolResult(listed)).toBe(true);
    expect(listed.kind).toBe("list_files");
    expect(listed.data.some((entry) => entry.name === "README.md")).toBe(true);

    const read = await readTextFile({ cwd, filePath: "README.md" });
    expect(isToolResult(read)).toBe(true);
    expect(read.kind).toBe("read_file");
    expect(read.data.content).toContain("procway");

    const matches = await searchFiles({ cwd, query: "procway" });
    expect(isToolResult(matches)).toBe(true);
    expect(matches.kind).toBe("search_files");
    expect(matches.data).toEqual([expect.objectContaining({ line: 1, text: "hello procway" })]);
  });

  it("windows large reads at the default cap and pages via offset", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "big.txt"), "a".repeat(70000), "utf8");

    const first = await readTextFile({ cwd, filePath: "big.txt" });
    expect(first.data.truncated).toBe(true);
    expect(first.data.totalChars).toBe(70000);
    expect(first.data.nextOffset).toBe(64000);
    // Continuation marker is inline so the model can't mistake the cut for EOF.
    expect(first.data.content).toContain("offset: 64000 to continue");

    const second = await readTextFile({ cwd, filePath: "big.txt", offset: first.data.nextOffset });
    expect(second.data.truncated).toBe(false);
    expect(second.data.offset).toBe(64000);
    expect(second.data.content).toBe("a".repeat(6000));

    // Explicit maxBytes still overrides the default window.
    const whole = await readTextFile({ cwd, filePath: "big.txt", maxBytes: 200000 });
    expect(whole.data.truncated).toBe(false);
    expect(whole.data.content.length).toBe(70000);
  });

  it("allows read tools outside cwd", async () => {
    const cwd = await makeWorkspace();
    const parent = path.dirname(cwd);
    const siblingDir = await mkdtemp(path.join(parent, "procway-sibling-"));
    tempDirs.push(siblingDir);
    const siblingRel = path.relative(cwd, siblingDir);
    await writeFile(path.join(siblingDir, "note.md"), "hello from sibling", "utf8");

    const read = await readTextFile({ cwd, filePath: path.join(siblingRel, "note.md") });
    expect(read.data.content).toBe("hello from sibling");

    const listed = await listFiles({ cwd, dirPath: siblingRel });
    expect(listed.data.some((entry) => entry.name === "note.md")).toBe(true);

    const matches = await searchFiles({ cwd, query: "sibling", dirPath: siblingRel });
    expect(matches.data).toEqual([expect.objectContaining({ line: 1, text: "hello from sibling" })]);
  });

  it("rejects write tools outside cwd", async () => {
    const cwd = await makeWorkspace();
    await expect(writeTextFile({ cwd, filePath: "../escape.txt", content: "x" })).rejects.toThrow("Path escapes workspace");
    await expect(
      applyUnifiedPatch({
        cwd,
        patch: [
          "diff --git a/../escape.txt b/../escape.txt",
          "--- /dev/null",
          "+++ b/../escape.txt",
          "@@ -0,0 +1,1 @@",
          "+x",
          ""
        ].join("\n")
      })
    ).rejects.toThrow("Path escapes workspace");
  });

  it("allows absolute paths inside the workspace", async () => {
    const cwd = await makeWorkspace();
    const filePath = path.join(cwd, "README.md");
    await writeFile(filePath, "inside", "utf8");

    const result = await readTextFile({ cwd, filePath });
    expect(isToolResult(result)).toBe(true);
    expect(result.data.content).toBe("inside");
  });

  it("applies unified patches to existing files", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "README.md"), "one\ntwo\nthree\n", "utf8");

    const result = await applyUnifiedPatch({
      cwd,
      patch: [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        ""
      ].join("\n")
    });

    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("apply_patch");
    expect(result.data).toEqual([expect.objectContaining({ hunks: 1 })]);
    await expect(readFile(path.join(cwd, "README.md"), "utf8")).resolves.toBe("one\nTWO\nthree\n");
  });

  it("applies unified patches that create files", async () => {
    const cwd = await makeWorkspace();

    const result = await applyUnifiedPatch({
      cwd,
      patch: [
        "diff --git a/new.txt b/new.txt",
        "--- /dev/null",
        "+++ b/nested/new.txt",
        "@@ -0,0 +1,2 @@",
        "+hello",
        "+world",
        ""
      ].join("\n")
    });

    expect(isToolResult(result)).toBe(true);
    expect(result.data).toEqual([expect.objectContaining({ operation: "create", hunks: 1 })]);
    await expect(readFile(path.join(cwd, "nested", "new.txt"), "utf8")).resolves.toBe("hello\nworld");
  });

  it("applies unified patches that delete files", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "old.txt"), "bye\n", "utf8");

    const result = await applyUnifiedPatch({
      cwd,
      patch: [
        "diff --git a/old.txt b/old.txt",
        "--- a/old.txt",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-bye",
        ""
      ].join("\n")
    });

    expect(isToolResult(result)).toBe(true);
    expect(result.data).toEqual([expect.objectContaining({ operation: "delete", hunks: 1, bytes: 0 })]);
    await expect(readFile(path.join(cwd, "old.txt"), "utf8")).rejects.toThrow();
  });
});

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
  tempDirs.push(dir);
  return dir;
}
