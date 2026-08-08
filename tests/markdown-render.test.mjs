import { describe, expect, it } from "vitest";
import { renderMarkdown, __test } from "../src/adapters/tui/markdown-render.mjs";
import { stripAnsi } from "../src/adapters/tui/ansi.mjs";

describe("markdown-render adapter — Markdown blocks", () => {
  // P3a-2: the `#` markers are dropped when colour is available — hierarchy is
  // carried by weight/colour, as in a rendered document.
  it("renders headings with bold + per-level colour and no '#' markers", () => {
    const out = renderMarkdown("# Title\n\n## Sub\n");
    expect(stripAnsi(out)).toContain("Title");
    expect(stripAnsi(out)).toContain("Sub");
    expect(stripAnsi(out)).not.toContain("#");
    expect(out).toContain("\x1b[1m"); // bold
  });

  it("keeps the '#' markers when colour is disabled", () => {
    const plain = renderMarkdown("# Title\n\n## Sub\n", { color: false });
    expect(plain).toContain("# Title");
    expect(plain).toContain("## Sub");
  });

  it("renders unordered lists with bullets", () => {
    const out = renderMarkdown("- one\n- two\n- three\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("• one");
    expect(plain).toContain("• two");
    expect(plain).toContain("• three");
  });

  it("renders numbered lists with the source markers", () => {
    const out = renderMarkdown("1. first\n2. second\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("1. first");
    expect(plain).toContain("2. second");
  });

  it("renders fenced code blocks and reports the language label", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("(js)");
    expect(plain).toContain("const x = 1;");
  });

  it("flags an unclosed fenced code block as streaming", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("(streaming)");
  });

  // Styles close with their specific off-code (SGR 22/23/24/39/49) instead of
  // a blanket reset so nesting survives — see ansi.mjs `wrap`.
  // P3a-3: inline code no longer paints a background (the grey/brightYellow
  // pill was unreadable on light themes) — foreground accent only.
  it("renders inline code with a foreground accent and no background fill", () => {
    const out = renderMarkdown("Use `npm install` to set up.");
    expect(out).toContain("\x1b[38;5;141mnpm install\x1b[39m");
    expect(out).not.toContain("\x1b[49m");
  });

  it("renders bold emphasis", () => {
    const out = renderMarkdown("This is **important**.");
    expect(out).toContain("\x1b[1mimportant\x1b[22m");
  });

  it("renders italic emphasis", () => {
    const out = renderMarkdown("This is *subtle*.");
    expect(out).toContain("\x1b[3msubtle\x1b[23m");
  });

  it("renders links with underline + url annotation", () => {
    const out = renderMarkdown("Visit [docs](https://example.com).");
    const plain = stripAnsi(out);
    expect(plain).toContain("docs");
    expect(plain).toContain("(https://example.com)");
    expect(out).toContain("\x1b[4m");
  });

  it("renders single-column tables", () => {
    const out = renderMarkdown("| name |\n|------|\n| foo  |\n| bar  |\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("name");
    expect(plain).toContain("foo");
    expect(plain).toContain("bar");
    expect(plain).toMatch(/┌.*┐/);
  });

  it("renders multi-column tables and aligns columns", () => {
    const out = renderMarkdown("| col-a | col-b |\n|-------|-------|\n| a1    | b1    |\n| a2    | b2    |\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("col-a");
    expect(plain).toContain("col-b");
    expect(plain).toContain("a1");
    expect(plain).toContain("b2");
    expect(plain).toMatch(/├.*┼.*┤/);
  });

  it("parseBlocks identifies the canonical block kinds", () => {
    const blocks = __test.parseBlocks("# h1\n\n- item\n\n```js\nconst x = 1;\n```\n");
    const kinds = blocks.map((block) => block.kind);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("list");
    expect(kinds).toContain("code");
  });
});
