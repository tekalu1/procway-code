import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { editFile } from "../src/tools/edit.mjs";

let cwd;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-edit-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("editFile", () => {
  it("performs a single unique replacement", async () => {
    await writeFile(path.join(cwd, "a.txt"), "hello world", "utf8");
    const result = await editFile({ cwd, filePath: "a.txt", oldString: "world", newString: "there" });
    expect(result.kind).toBe("edit");
    expect(result.summary).toContain("1 occurrence");
    expect(result.data.replacedCount).toBe(1);
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("hello there");
  });

  it("rejects ambiguous matches and lists candidates", async () => {
    await writeFile(path.join(cwd, "a.txt"), "foo foo foo", "utf8");
    const result = await editFile({ cwd, filePath: "a.txt", oldString: "foo", newString: "bar" });
    expect(result.summary).toMatch(/^Edit failed/);
    expect(result.data.candidates).toHaveLength(3);
    expect(result.data.candidates[0]).toEqual(expect.objectContaining({ line: 1, column: 1 }));
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("foo foo foo");
  });

  it("rejects when no match is found", async () => {
    await writeFile(path.join(cwd, "a.txt"), "abc", "utf8");
    const result = await editFile({ cwd, filePath: "a.txt", oldString: "xyz", newString: "uvw" });
    expect(result.summary).toMatch(/^Edit failed/);
    expect(result.data.error).toContain("No match");
  });

  it("supports replaceAll across multiple occurrences", async () => {
    await writeFile(path.join(cwd, "a.txt"), "foo foo foo", "utf8");
    const result = await editFile({ cwd, filePath: "a.txt", oldString: "foo", newString: "bar", replaceAll: true });
    expect(result.kind).toBe("edit");
    expect(result.data.replacedCount).toBe(3);
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("bar bar bar");
  });

  it("returns an error result when the file is missing", async () => {
    const result = await editFile({ cwd, filePath: "missing.txt", oldString: "a", newString: "b" });
    expect(result.summary).toMatch(/^Edit failed/);
    expect(result.data.error).toContain("Failed to read");
  });

  it("rejects paths outside the workspace", async () => {
    const outside = path.resolve(cwd, "..", "outside.txt");
    const result = await editFile({ cwd, filePath: outside, oldString: "a", newString: "b" });
    expect(result.summary).toMatch(/^Edit failed/);
    expect(result.data.error).toContain("escapes workspace");
  });

  it("rejects when oldString === newString", async () => {
    await writeFile(path.join(cwd, "a.txt"), "abc", "utf8");
    const result = await editFile({ cwd, filePath: "a.txt", oldString: "a", newString: "a" });
    expect(result.summary).toMatch(/^Edit failed/);
    expect(result.data.error).toContain("must differ");
  });
});
