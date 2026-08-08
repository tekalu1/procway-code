import { describe, expect, it } from "vitest";
import { renderMarkdown, __test } from "../src/adapters/tui/markdown-render.mjs";
import { stripAnsi, visibleWidth, color, bold } from "../src/adapters/tui/ansi.mjs";

const { wrap } = __test;

/** Visible width of the widest rendered line — the property every case asserts. */
function maxWidth(rendered) {
  return Math.max(...stripAnsi(rendered).split("\n").map((line) => visibleWidth(line)));
}

function lines(rendered) {
  return stripAnsi(rendered).split("\n");
}

describe("wrap — CJK", () => {
  it("breaks Japanese per character instead of never breaking (P3a-1)", () => {
    const out = wrap("あ".repeat(120), { width: 80 });
    const rows = out.split("\n");
    expect(rows.length).toBe(3);
    expect(Math.max(...rows.map(visibleWidth))).toBeLessThanOrEqual(80);
  });

  it("keeps every rendered paragraph line inside the width", () => {
    const md = "これは日本語の長い段落です。折り返しが正しく機能するかどうかを確認するために、わざと長くしています。さらに続きます。";
    for (const width of [80, 60, 40, 20, 12]) {
      const out = renderMarkdown(md, { width });
      expect(maxWidth(out)).toBeLessThanOrEqual(width);
    }
  });

  it("does not strand a bullet on a line of its own", () => {
    const md = [
      "- 1つ目の項目です",
      "- 2つ目のとても長い項目でここは折り返しが必要になるくらい長い文章になっています。さらに続きます。"
    ].join("\n");
    const out = renderMarkdown(md, { width: 40 });
    const rows = lines(out).filter((row) => row.trim().length > 0);
    expect(rows.some((row) => row.trim() === "•")).toBe(false);
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(40);
      if (row.startsWith("•")) expect(visibleWidth(row)).toBeGreaterThan(2);
    }
    // Continuation lines are indented under the bullet text.
    expect(rows.filter((row) => row.startsWith("  ")).length).toBeGreaterThan(0);
  });

  it("still breaks English on word boundaries", () => {
    const out = wrap("alpha beta gamma delta epsilon zeta", { width: 16 });
    expect(out.split("\n")).toEqual(["alpha beta gamma", "delta epsilon", "zeta"]);
  });

  it("hard-splits a token that cannot fit on any line", () => {
    const out = wrap("https://example.com/a/very/long/path/that/never/breaks", { width: 20 });
    for (const row of out.split("\n")) expect(visibleWidth(row)).toBeLessThanOrEqual(20);
    expect(stripAnsi(out).replace(/\n/g, "")).toBe("https://example.com/a/very/long/path/that/never/breaks");
  });

  it("applies a hanging indent to continuation lines", () => {
    const out = wrap("• これは長い項目のテキストです。折り返しても揃います。", { width: 20, indent: 2 });
    const rows = out.split("\n");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(1)) expect(row.startsWith("  ")).toBe(true);
  });
});

describe("wrap — kinsoku (簡易禁則)", () => {
  it("never starts a line with closing punctuation", () => {
    const text = "あいうえおかきくけこ。さしすせそたちつてと、なにぬねの。";
    for (const width of [10, 12, 14, 16, 20, 22]) {
      for (const row of wrap(text, { width }).split("\n")) {
        expect(row.length > 0 && "。、）」".includes(row[0])).toBe(false);
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("never ends a line with an opening bracket", () => {
    const text = "あいうえおかきくけこ（さしすせそ）たちつてとなにぬねの";
    for (const width of [10, 12, 14, 16, 18, 20, 22]) {
      for (const row of wrap(text, { width }).split("\n")) {
        expect(row.length > 0 && "（「『［".includes(row[row.length - 1])).toBe(false);
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("wrap — ANSI and grapheme safety", () => {
  it("measures colour sequences as zero width and never cuts one in half", () => {
    const decorated = `${color("cyan", "あ".repeat(40))} ${bold("tail")}`;
    const out = wrap(decorated, { width: 30 });
    for (const row of out.split("\n")) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(30);
      // No orphaned escape introducer and no truncated CSI.
      expect(row.includes("\x1b") ? /\x1b\[[0-9;]*m/.test(row) : true).toBe(true);
      expect(row.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b");
    }
    expect(stripAnsi(out).replace(/\n/g, "")).toBe(`${"あ".repeat(40)} tail`);
  });

  it("keeps ANSI-decorated words intact across the wrap boundary", () => {
    const out = wrap(`start ${color("green", "middleword")} end`, { width: 10 });
    expect(out).toContain(color("green", "middleword"));
  });

  it("does not split emoji, ZWJ sequences or flags", () => {
    const atoms = ["👨‍👩‍👧‍👦", "🇯🇵", "👍🏽", "é"];
    const text = atoms.join("x".repeat(6));
    for (let width = 4; width <= 30; width += 1) {
      const out = wrap(text, { width });
      for (const atom of atoms) {
        // Each cluster survives on exactly one line (no newline inserted inside).
        expect(out.split("\n").some((row) => row.includes(atom))).toBe(true);
      }
      for (const row of out.split("\n")) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  });

  it("wraps emoji-bearing prose inside the terminal width", () => {
    const md = "絵文字混じり: 👨‍👩‍👧‍👦 家族と 🇯🇵 国旗と ✓ チェック、それから long text follows here to force a wrap.";
    for (const width of [80, 40, 24]) {
      expect(maxWidth(renderMarkdown(md, { width }))).toBeLessThanOrEqual(width);
    }
  });
});

describe("markdown blocks — Phase 3a additions", () => {
  it("renders a horizontal rule as a ruler, not literal dashes", () => {
    const out = renderMarkdown("a\n\n---\n\nb\n", { width: 20 });
    const plain = lines(out);
    expect(plain).toContain("─".repeat(20));
    expect(plain).not.toContain("---");
  });

  it("renders block quotes with a vertical rule", () => {
    const out = renderMarkdown("> 引用です。\n> 二行目。\n", { width: 30 });
    for (const row of lines(out).filter((line) => line.trim())) {
      expect(row.startsWith("│ ")).toBe(true);
      expect(visibleWidth(row)).toBeLessThanOrEqual(30);
    }
  });

  it("renders task list items as checkboxes", () => {
    const out = renderMarkdown("- [ ] todo\n- [x] done\n", { width: 40 });
    const plain = stripAnsi(out);
    expect(plain).toContain("[ ] todo");
    expect(plain).toContain("[✓] done");
    expect(plain).not.toContain("• [");
  });

  it("keeps a list attached to its lead-in paragraph", () => {
    const out = renderMarkdown("Steps:\n- one\n- two\n", { width: 40 });
    const plain = stripAnsi(out);
    expect(plain).toContain("Steps:");
    expect(plain).toContain("• one");
    expect(plain).toContain("• two");
  });

  it("frames code blocks with a rule instead of a filled background", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```\n", { width: 60 });
    expect(out).not.toContain("\x1b[40m"); // no black background fill
    expect(stripAnsi(out)).toContain("│ const x = 1;");
    // The gutter is the only decoration — no padding to the terminal edge.
    expect(maxWidth(out)).toBeLessThanOrEqual(60);
  });
});

describe("markdown tables — column measurement (P3a-4)", () => {
  it("measures rendered cells, not raw Markdown", () => {
    const md = [
      "| key | value |",
      "|-----|-------|",
      "| **verylongbold** | x |",
      "| a | y |"
    ].join("\n");
    const rows = lines(renderMarkdown(md, { width: 80 })).filter((line) => line.trim());
    const widths = rows.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    // `**verylongbold**` draws as 12 columns: 12 + 2 padding + 2 borders + …
    expect(widths[0]).toBe(visibleWidth("┌──────────────┬───────┐"));
  });

  it("aligns Japanese cells", () => {
    const md = [
      "| 名前 | 説明 |",
      "|------|------|",
      "| 太字 | 日本語の説明 |",
      "| a | `inline` |"
    ].join("\n");
    const rows = lines(renderMarkdown(md, { width: 80 })).filter((line) => line.trim());
    expect(new Set(rows.map(visibleWidth)).size).toBe(1);
  });

  it("shrinks columns so a wide table still fits a narrow terminal", () => {
    const md = [
      "| 名前 | 説明 | 状態 |",
      "|------|------|------|",
      "| 太字セル | 日本語の説明テキスト | ok |"
    ].join("\n");
    const out = renderMarkdown(md, { width: 40 });
    expect(maxWidth(out)).toBeLessThanOrEqual(40);
    expect(new Set(lines(out).filter((line) => line.trim()).map(visibleWidth)).size).toBe(1);
  });
});

describe("markdown — narrow terminals", () => {
  it("never exceeds the requested width for a mixed document", () => {
    const md = [
      "# 見出し",
      "",
      "本文です。**強調**と`コード`と[リンク](https://example.com)を含みます。",
      "",
      "- 箇条書きの項目がここにあります",
      "- [ ] タスク",
      "",
      "> 引用文です。",
      "",
      "---",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      ""
    ].join("\n");
    for (const width of [80, 60, 40, 24]) {
      expect(maxWidth(renderMarkdown(md, { width }))).toBeLessThanOrEqual(width);
    }
  });
});
