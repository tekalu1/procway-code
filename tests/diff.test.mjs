import { describe, expect, it } from "vitest";
import { renderDiff, diffLines } from "../src/adapters/tui/diff.mjs";
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
    expect(plain).toMatch(/\+\s+1: export const foo = 1;/);
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
    expect(plain).toMatch(/-\s+1: delete-me/);
  });

  it("renders a modification with mixed +/- lines and context", () => {
    const out = renderDiff({
      filePath: "src/bar.mjs",
      before: ["a", "b", "c", "d"].join("\n"),
      after: ["a", "b", "C", "d"].join("\n")
    });
    const plain = stripAnsi(out);
    expect(plain).toContain("~ Modified: src/bar.mjs");
    expect(plain).toMatch(/-\s+3: c/);
    expect(plain).toMatch(/\+\s+3: C/);
    expect(plain).toMatch(/\s+1: a/);
    expect(plain).toMatch(/\s+4: d/);
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
});
