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

  // P3d-1 / P3d-3. `asSnapshot` renders OSC 8 as `[link=URI]…[/link]`, so the
  // reviewer can check by eye that (a) the URI is still printed next to the
  // label, (b) unsafe schemes never become a link region at all.
  const STRIKE_AND_LINKS = [
    "~~打ち消し~~ と See [docs](https://example.com/docs) for more.",
    "",
    "Mixed ~~**struck bold**~~ and **~~bold struck~~**.",
    "",
    "- [x] ~~done~~ with [link](https://example.com/l)",
    "",
    "[bad](javascript:alert(1)) and [f](file:///etc/passwd) stay plain.",
    ""
  ].join("\n");

  it("renders strikethrough and links — terminal without OSC 8 support", () => {
    expect(asSnapshot(renderMarkdown(STRIKE_AND_LINKS, { width: 60, hyperlinks: false }))).toMatchSnapshot();
  });

  it("renders strikethrough and links — terminal with OSC 8 support", () => {
    expect(asSnapshot(renderMarkdown(STRIKE_AND_LINKS, { width: 60, hyperlinks: true }))).toMatchSnapshot();
  });

  it("renders strikethrough and links — no colour (markers kept, no escapes)", () => {
    expect(asSnapshot(renderMarkdown(STRIKE_AND_LINKS, { width: 60, color: false, hyperlinks: true }))).toMatchSnapshot();
  });

  it("re-opens a wrapped link on each row so padding never becomes clickable", () => {
    const md = "Prefix text here [a very long link label that will certainly wrap](https://example.com/some/deep/path) tail.\n";
    expect(asSnapshot(renderMarkdown(md, { width: 40, hyperlinks: true }))).toMatchSnapshot();
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
