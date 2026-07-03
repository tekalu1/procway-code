import { describe, expect, it } from "vitest";
import { renderTranscript, renderMarkdown, __test } from "../src/adapters/tui/markdown-render.mjs";
import { stripAnsi } from "../src/adapters/tui/ansi.mjs";

describe("markdown-render adapter — transcript layer", () => {
  it("renders user / assistant / tool projections with role labels", () => {
    const text = renderTranscript([
      { role: "system", content: "ignored" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", content: "{\"path\":\"README.md\"}" }
    ]);
    expect(text).not.toContain("ignored");
    expect(text).toContain("You: hello");
    expect(text).toContain("Assistant: hi");
    expect(text).toContain("Tool: {\"path\":\"README.md\"}");
  });

  it("returns the no-history sentinel when projection is empty", () => {
    expect(renderTranscript([])).toBe("(no prior conversation)\n");
  });

  it("does not truncate by default", () => {
    const longText = "x".repeat(2000);
    const text = renderTranscript([{ role: "assistant", content: longText }]);
    expect(text).toContain(longText);
    expect(text).not.toContain("[truncated]");
  });

  it("truncates when maxChars is provided", () => {
    const text = renderTranscript([{ role: "assistant", content: "abcdef" }], { maxChars: 3 });
    expect(text).toContain("abc\n...[truncated]");
  });

  it("collapses tool_calls into a [tool calls: name] line", () => {
    const text = renderTranscript([
      { role: "assistant", content: null, tool_calls: [{ function: { name: "read_file" } }] }
    ]);
    expect(text).toContain("Assistant: [tool calls: read_file]");
  });
});

describe("markdown-render adapter — Markdown blocks", () => {
  it("renders headings with bold + per-level colour", () => {
    const out = renderMarkdown("# Title\n\n## Sub\n");
    expect(stripAnsi(out)).toContain("# Title");
    expect(stripAnsi(out)).toContain("## Sub");
    expect(out).toContain("\x1b[1m"); // bold
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

  it("renders inline code with a colour pair", () => {
    const out = renderMarkdown("Use `npm install` to set up.");
    expect(out).toMatch(/\x1b\[\d+m.*npm install.*\x1b\[0m/);
  });

  it("renders bold emphasis", () => {
    const out = renderMarkdown("This is **important**.");
    expect(out).toContain("\x1b[1mimportant\x1b[0m");
  });

  it("renders italic emphasis", () => {
    const out = renderMarkdown("This is *subtle*.");
    expect(out).toContain("\x1b[3msubtle\x1b[0m");
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
