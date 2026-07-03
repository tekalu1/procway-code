import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/adapters/tui/markdown-render.mjs";
import { renderDiff } from "../src/adapters/tui/diff.mjs";
import { renderToolCall } from "../src/adapters/tui/tool-render.mjs";
import { asSnapshot } from "./helpers/ansi.mjs";

describe("snapshot — markdown rendering", () => {
  it("renders a tutorial document", () => {
    const md = [
      "# Heading One",
      "",
      "Some intro text with **bold** and *italic* and `inline code`.",
      "",
      "## Subsection",
      "",
      "- bullet alpha",
      "- bullet beta",
      "",
      "1. step one",
      "2. step two",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "[link text](https://example.com) closes it.",
      ""
    ].join("\n");
    expect(asSnapshot(renderMarkdown(md, { width: 60 }))).toMatchSnapshot();
  });

  it("renders a multi-column table", () => {
    const md = [
      "| name | age |",
      "|------|-----|",
      "| ada  |  36 |",
      "| grace|  85 |"
    ].join("\n");
    expect(asSnapshot(renderMarkdown(md, { width: 60 }))).toMatchSnapshot();
  });

  it("renders a fenced code block — no colour", () => {
    const md = "```ts\nfunction foo(): number {\n  return 1;\n}\n```\n";
    expect(asSnapshot(renderMarkdown(md, { width: 60, color: false }))).toMatchSnapshot();
  });
});

describe("snapshot — diff preview", () => {
  it("creation banner", () => {
    const out = renderDiff({
      filePath: "src/foo.mjs",
      operation: "create",
      after: "export const foo = 1;\nexport const bar = 2;\n"
    });
    expect(asSnapshot(out)).toMatchSnapshot();
  });

  it("modification with mixed adds + removes", () => {
    const out = renderDiff({
      filePath: "src/bar.mjs",
      before: ["a", "b", "old", "d"].join("\n"),
      after: ["a", "b", "new", "d"].join("\n")
    });
    expect(asSnapshot(out)).toMatchSnapshot();
  });
});

describe("snapshot — tool renderer", () => {
  it("collapsed run_shell summary", () => {
    const out = renderToolCall({
      name: "run_shell",
      args: { command: "pnpm test" },
      ok: true,
      previewLines: 3,
      result: {
        kind: "run_shell",
        summary: "tests 185 passed",
        data: { stdout: "Test Files 47 passed\nTests 185 passed\n(line three)\n(line four)\n", stderr: "" }
      }
    });
    expect(asSnapshot(out)).toMatchSnapshot();
  });

  it("read_file body", () => {
    const out = renderToolCall({
      name: "read_file",
      args: { filePath: "README.md" },
      ok: true,
      previewLines: 4,
      result: {
        kind: "read_file",
        summary: "Read 1.2 KB from README.md",
        data: { path: "README.md", content: "# project\n\nhello world\n", truncated: false }
      }
    });
    expect(asSnapshot(out)).toMatchSnapshot();
  });
});
