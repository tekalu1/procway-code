import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { runGlob, compileGlob } from "../src/tools/glob.mjs";

function makeFailingSpawn() {
  // Simulates a system without ripgrep — both `rg --version` and `rg --files` error out.
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("ENOENT")));
    return child;
  };
}

describe("Glob tool (JS fallback)", () => {
  let cwd;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "procway-glob-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await mkdir(path.join(cwd, "src", "nested"), { recursive: true });
    await mkdir(path.join(cwd, "node_modules", "junk"), { recursive: true });
    await writeFile(path.join(cwd, "src", "a.mjs"), "// a", "utf8");
    await writeFile(path.join(cwd, "src", "b.mjs"), "// b", "utf8");
    await writeFile(path.join(cwd, "src", "nested", "c.mjs"), "// c", "utf8");
    await writeFile(path.join(cwd, "src", "skip.txt"), "txt", "utf8");
    await writeFile(path.join(cwd, "node_modules", "junk", "ignored.mjs"), "// ignored", "utf8");
    await writeFile(path.join(cwd, ".gitignore"), "skip.txt\n", "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns matching files for `**/*.mjs`", async () => {
    const result = await runGlob({ pattern: "**/*.mjs", cwd, spawnImpl: makeFailingSpawn() });
    const rels = result.data.matches.map((entry) => entry.relPath).sort();
    expect(rels).toContain("src/a.mjs");
    expect(rels).toContain("src/b.mjs");
    expect(rels).toContain("src/nested/c.mjs");
    expect(rels).not.toContain("node_modules/junk/ignored.mjs");
  });

  it("filters by directory", async () => {
    const result = await runGlob({ pattern: "*.mjs", dirPath: "src", cwd, spawnImpl: makeFailingSpawn() });
    const rels = result.data.matches.map((entry) => entry.relPath).sort();
    expect(rels).toEqual(["a.mjs", "b.mjs"]);
  });

  it("respects .gitignore for top-level paths", async () => {
    const result = await runGlob({ pattern: "src/*.txt", cwd, spawnImpl: makeFailingSpawn() });
    expect(result.data.matches).toHaveLength(0);
  });

  it("can disable .gitignore via respectGitignore=false", async () => {
    const result = await runGlob({ pattern: "src/*.txt", cwd, respectGitignore: false, spawnImpl: makeFailingSpawn() });
    expect(result.data.matches.map((entry) => entry.relPath)).toEqual(["src/skip.txt"]);
  });

  it("truncates results when maxResults is reached", async () => {
    const result = await runGlob({ pattern: "**/*.mjs", maxResults: 1, cwd, spawnImpl: makeFailingSpawn() });
    expect(result.data.matches).toHaveLength(1);
    expect(result.data.truncated).toBe(true);
  });

  it("returns a structured ToolResult with kind=search_files", async () => {
    const result = await runGlob({ pattern: "**/*.mjs", cwd, spawnImpl: makeFailingSpawn() });
    expect(result.kind).toBe("search_files");
    expect(result.summary).toMatch(/Found \d+\+? match\(es\) for/);
    expect(result.data.pattern).toBe("**/*.mjs");
  });

  it("compileGlob handles {a,b}, ?, and **", () => {
    const matcher = compileGlob("src/**/*.{mjs,ts}");
    expect(matcher("src/a.mjs")).toBe(true);
    expect(matcher("src/nested/c.ts")).toBe(true);
    expect(matcher("src/a.txt")).toBe(false);
  });

  it("excludes .pnpm-store from JS fallback walks", async () => {
    await mkdir(path.join(cwd, ".pnpm-store"), { recursive: true });
    await writeFile(path.join(cwd, ".pnpm-store", "pkg.mjs"), "// pnpm-store", "utf8");
    const result = await runGlob({ pattern: "**/*.mjs", cwd, spawnImpl: makeFailingSpawn() });
    const rels = result.data.matches.map((entry) => entry.relPath);
    expect(rels).not.toContain(".pnpm-store/pkg.mjs");
  });
});
