import { describe, expect, it } from "vitest";
import { renderDiff, diffLines, diffOps, buildHunks, MAX_DIFF_CELLS } from "../src/adapters/tui/diff.mjs";
import { stripAnsi } from "../src/adapters/tui/ansi.mjs";

describe("diff adapter", () => {
  it("renders a creation banner with green '+' lines", () => {
    const out = renderDiff({
      filePath: "src/foo.mjs",
      before: "",
      after: "export const foo = 1;\n",
      operation: "create"
    });
    const plain = stripAnsi(out);
    expect(plain).toContain("+ Created: src/foo.mjs");
    expect(plain).toContain("@@ -0,0 +1,1 @@");
    expect(plain).toContain("+export const foo = 1;");
    expect(out).toContain("\x1b[32m");
  });

  it("renders a deletion banner with red '-' lines", () => {
    const out = renderDiff({
      filePath: "src/legacy.mjs",
      before: "delete-me\n",
      after: "",
      operation: "delete"
    });
    const plain = stripAnsi(out);
    expect(plain).toContain("- Deleted: src/legacy.mjs");
    expect(plain).toContain("@@ -1,1 +0,0 @@");
    expect(plain).toContain("-delete-me");
  });

  it("renders a modification as a unified hunk", () => {
    const out = renderDiff({
      filePath: "src/bar.mjs",
      before: ["a", "b", "c", "d"].join("\n"),
      after: ["a", "b", "C", "d"].join("\n")
    });
    const plain = stripAnsi(out).trimEnd();
    expect(plain.split("\n")).toEqual([
      "~ Modified: src/bar.mjs",
      "@@ -1,4 +1,4 @@",
      " a",
      " b",
      "-c",
      "+C",
      " d"
    ]);
  });

  // Unified diff convention: removals come before additions inside a run.
  it("prints removals before additions", () => {
    const out = renderDiff({
      filePath: "x.txt",
      before: ["keep", "one", "two", "keep2"].join("\n"),
      after: ["keep", "uno", "dos", "keep2"].join("\n")
    });
    const plain = stripAnsi(out);
    const minus = plain.indexOf("-one");
    const plus = plain.indexOf("+uno");
    expect(minus).toBeGreaterThan(-1);
    expect(plus).toBeGreaterThan(-1);
    expect(minus).toBeLessThan(plus);
    expect(plain.indexOf("-two")).toBeLessThan(plus);
  });

  it("emits one hunk per change region with three lines of context", () => {
    const before = Array.from({ length: 40 }, (_, idx) => `line ${idx + 1}`);
    const after = before.slice();
    after[4] = "line 5 changed";
    after[30] = "line 31 changed";
    const out = renderDiff({ filePath: "big.txt", before: before.join("\n"), after: after.join("\n"), maxLines: 200 });
    const plain = stripAnsi(out);
    const headers = plain.split("\n").filter((line) => line.startsWith("@@"));
    expect(headers).toEqual(["@@ -2,7 +2,7 @@", "@@ -28,7 +28,7 @@"]);
    // Untouched regions between hunks are omitted entirely.
    expect(plain).not.toContain("line 15");
  });

  it("keeps a single hunk when two changes are close together", () => {
    const before = Array.from({ length: 20 }, (_, idx) => `line ${idx + 1}`);
    const after = before.slice();
    after[8] = "nine!";
    after[11] = "twelve!";
    const out = renderDiff({ filePath: "near.txt", before: before.join("\n"), after: after.join("\n"), maxLines: 200 });
    const headers = stripAnsi(out).split("\n").filter((line) => line.startsWith("@@"));
    expect(headers).toHaveLength(1);
  });

  it("reports no changes when both sides match", () => {
    const out = renderDiff({ filePath: "same.txt", before: "a\nb\n", after: "a\nb\n" });
    expect(stripAnsi(out)).toContain("(no changes)");
  });

  it("truncates large diffs with a 'show more' trailer", () => {
    const before = Array.from({ length: 80 }, (_, idx) => `before-${idx}`).join("\n");
    const after = Array.from({ length: 80 }, (_, idx) => `after-${idx}`).join("\n");
    const out = renderDiff({ filePath: "big.txt", before, after, maxLines: 10 });
    const plain = stripAnsi(out);
    expect(plain).toContain("more lines, show more for full diff");
  });

  it("diffLines returns alternating remove/add ops for full replacements", () => {
    const ops = diffLines(["x"], ["y"]);
    const types = ops.map((entry) => entry.type);
    expect(types).toContain("remove");
    expect(types).toContain("add");
  });

  it("carries before/after line numbers on every op", () => {
    const { ops } = diffOps(["a", "b"], ["a", "B"]);
    expect(ops).toEqual([
      { type: "context", text: "a", beforeLine: 1, afterLine: 1 },
      { type: "remove", text: "b", beforeLine: 2, afterLine: null },
      { type: "add", text: "B", beforeLine: null, afterLine: 2 }
    ]);
  });

  it("buildHunks keeps context-only op streams empty", () => {
    const { ops } = diffOps(["a", "b"], ["a", "b"]);
    expect(buildHunks(ops)).toEqual([]);
  });

  // LCS is O(N*M): common head/tail lines are trimmed first, and anything
  // still over the cell budget degrades to a whole-region replacement.
  it("diffs a large file cheaply when only one line changed", () => {
    const before = Array.from({ length: 20000 }, (_, idx) => `line ${idx}`);
    const after = before.slice();
    after[10000] = "changed";
    const started = Date.now();
    const { ops, degraded } = diffOps(before, after);
    expect(degraded).toBe(false);
    expect(ops.filter((op) => op.type !== "context")).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("degrades to a full replacement when the change region is too large", () => {
    const size = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 50;
    const before = Array.from({ length: size }, (_, idx) => `a-${idx}`);
    const after = Array.from({ length: size }, (_, idx) => `b-${idx}`);
    const { degraded, ops } = diffOps(before, after);
    expect(degraded).toBe(true);
    expect(ops.filter((op) => op.type === "remove")).toHaveLength(size);
    expect(ops.filter((op) => op.type === "add")).toHaveLength(size);
    const out = renderDiff({ filePath: "huge.txt", before: before.join("\n"), after: after.join("\n"), maxLines: 5 });
    expect(stripAnsi(out)).toContain("diff too large");
  });
});
