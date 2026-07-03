import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyUnifiedPatch,
  listFiles,
  readTextFile,
  searchFiles,
  writeTextFile
} from "../src/tools/filesystem.mjs";
import { runShell } from "../src/tools/shell.mjs";
import { isToolResult } from "../src/core/types/tool-result.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-tool-result-"));
  tempDirs.push(dir);
  return dir;
}

describe("tools return canonical ToolResult shapes", () => {
  it("listFiles returns kind=list_files with summary and data array", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "x.txt"), "x", "utf8");
    const result = await listFiles({ cwd, dirPath: "." });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("list_files");
    expect(result.summary).toMatch(/Listed \d+ entries/);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("readTextFile returns kind=read_file with content under data", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "x.txt"), "hello", "utf8");
    const result = await readTextFile({ cwd, filePath: "x.txt" });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("read_file");
    expect(result.data.content).toBe("hello");
    expect(result.data.truncated).toBe(false);
  });

  it("searchFiles returns kind=search_files with match list under data", async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, "x.txt"), "alpha\nbravo\n", "utf8");
    const result = await searchFiles({ cwd, query: "bravo" });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("search_files");
    expect(result.data).toEqual([expect.objectContaining({ line: 2, text: "bravo" })]);
  });

  it("writeTextFile returns kind=write_file with bytes under data", async () => {
    const cwd = await makeWorkspace();
    const result = await writeTextFile({ cwd, filePath: "out.txt", content: "abcdef" });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("write_file");
    expect(result.data.bytes).toBe(6);
    expect(result.summary).toContain("out.txt");
  });

  it("applyUnifiedPatch returns kind=apply_patch with file results array", async () => {
    const cwd = await makeWorkspace();
    const result = await applyUnifiedPatch({
      cwd,
      patch: [
        "diff --git a/n.txt b/n.txt",
        "--- /dev/null",
        "+++ b/n.txt",
        "@@ -0,0 +1,1 @@",
        "+hi",
        ""
      ].join("\n")
    });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("apply_patch");
    expect(result.data).toEqual([expect.objectContaining({ operation: "create" })]);
  });

  it("runShell returns kind=run_shell with command output under data", async () => {
    const result = await runShell({
      cwd: process.cwd(),
      command: process.platform === "win32" ? "cmd /c echo hello" : "echo hello",
      timeoutMs: 10000
    });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("run_shell");
    expect(result.data.exitCode).toBe(0);
    expect(result.data.stdout.trim()).toBe("hello");
  });
});
