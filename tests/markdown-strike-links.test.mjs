import { describe, expect, it } from "vitest";
import { renderMarkdown, __test } from "../src/adapters/tui/markdown-render.mjs";
import { ansiToPlaceholders, stripAnsi, visibleWidth } from "../src/adapters/tui/ansi.mjs";

const OPEN = (uri) => `\x1b]8;;${uri}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";

/** Count OSC 8 opens (non-empty URI) and closes (empty URI) in a string. */
function linkRegions(text) {
  const opens = [];
  let closes = 0;
  for (const match of text.matchAll(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
    if (match[1]) opens.push(match[1]);
    else closes += 1;
  }
  return { opens, closes };
}

describe("markdown — strikethrough (~~text~~)", () => {
  it("draws SGR 9, paired with dim so a terminal that drops SGR 9 still reads as struck", () => {
    const out = renderMarkdown("~~gone~~ stays.");
    // dim wraps strikethrough: SGR 2 is universal, SGR 9 is not, and a
    // silently-dropped strikethrough is indistinguishable from plain prose.
    expect(out).toContain("\x1b[2m\x1b[9mgone\x1b[29m\x1b[22m");
    expect(stripAnsi(out).trim()).toBe("gone stays.");
  });

  it("keeps the ~~ markers when colour is off, exactly as headings keep their #", () => {
    const out = renderMarkdown("~~打ち消し~~ と普通の文。", { color: false });
    expect(out).toContain("~~打ち消し~~");
    expect(out).not.toContain("\x1b");
  });

  it("survives every nesting order with bold / italic / code / links", () => {
    // Bold outside, strike inside.
    expect(ansiToPlaceholders(renderMarkdown("**~~a~~** t").trim()))
      .toBe("[bold][dim][strike]a[/strike][/intensity][/intensity] t");
    // Strike outside, bold inside — the delimiter `~` cannot occur inside an
    // SGR run, so the strike pass can safely match text that already holds
    // escapes (which is why it runs after bold/italic, not before).
    expect(ansiToPlaceholders(renderMarkdown("~~**a**~~ t").trim()))
      .toBe("[dim][strike][bold]a[dim][/strike][/intensity] t");
    expect(stripAnsi(renderMarkdown("~~*a*~~ t")).trim()).toBe("a t");
    // A link right after a struck span: the link regex must not be dragged
    // into the escapes the strike pass injected (the P3a bug class).
    const mixed = renderMarkdown("~~old~~ see [docs](https://example.com) now.");
    expect(stripAnsi(mixed).trim()).toBe("old see docs (https://example.com) now.");
  });

  it("measures a struck CJK run by its glyphs, so wrapping is unaffected", () => {
    const out = renderMarkdown("~~日本語~~ の続き", { width: 40 });
    expect(visibleWidth(out.split("\n")[0])).toBe(visibleWidth("日本語 の続き"));
  });

  it("leaves a lone ~ and an empty ~~~~ alone", () => {
    expect(stripAnsi(renderMarkdown("a ~ b")).trim()).toBe("a ~ b");
    expect(stripAnsi(renderMarkdown("a ~~~~ b")).trim()).toBe("a ~~~~ b");
  });
});

describe("markdown — OSC 8 hyperlinks", () => {
  const md = "See [docs](https://example.com/docs) for more.";

  it("keeps the plain `text (url)` form when the terminal is not known to support OSC 8", () => {
    const out = renderMarkdown(md, { width: 80, hyperlinks: false });
    expect(out).not.toContain("\x1b]8;");
    expect(stripAnsi(out).trim()).toBe("See docs (https://example.com/docs) for more.");
  });

  it("wraps label AND url in one link region, so the destination stays readable", () => {
    const out = renderMarkdown(md, { width: 80, hyperlinks: true });
    // The URL is NOT hidden behind the label: a link whose visible text and
    // destination disagree is exactly what a phishing link looks like, and
    // this text comes from a model.
    expect(stripAnsi(out).trim()).toBe("See docs (https://example.com/docs) for more.");
    expect(out).toContain(OPEN("https://example.com/docs"));
    expect(out).toContain(CLOSE);
    const { opens, closes } = linkRegions(out);
    expect(opens).toEqual(["https://example.com/docs"]);
    expect(closes).toBe(1);
    // The escapes carry no width, so the paragraph still measures 45 columns.
    expect(visibleWidth(out.split("\n")[0])).toBe(45);
  });

  it("never links a dangerous scheme — it stays plain text", () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vscode://x"]) {
      const out = renderMarkdown(`[click](${uri}) end`, { width: 80, hyperlinks: true });
      expect(out, uri).not.toContain("\x1b]8;");
      expect(stripAnsi(out), uri).toContain(uri);
    }
  });

  it("never links a URI carrying control characters", () => {
    const out = renderMarkdown("[x](https://evil.com/\x07boom) end", { width: 80, hyperlinks: true });
    expect(out).not.toContain("\x1b]8;");
  });

  it("emits no escapes at all when colour is off", () => {
    const out = renderMarkdown(md, { width: 80, color: false, hyperlinks: true });
    expect(out).not.toContain("\x1b");
    expect(out.trim()).toBe("See docs (https://example.com/docs) for more.");
  });

  it("links inside headings, list items and table cells too", () => {
    const doc = [
      "# Title [h](https://example.com/h)",
      "",
      "- item [l](https://example.com/l)",
      "",
      "| a | b |",
      "|---|---|",
      "| x | [t](https://example.com/t) |",
      ""
    ].join("\n");
    const out = renderMarkdown(doc, { width: 80, hyperlinks: true });
    const { opens, closes } = linkRegions(out);
    expect(opens).toEqual([
      "https://example.com/h",
      "https://example.com/l",
      "https://example.com/t"
    ]);
    expect(closes).toBe(3);
    // The table still lines up: OSC 8 contributes no columns to the cell.
    const rows = stripAnsi(out).split("\n").filter((line) => line.startsWith("┌") || line.startsWith("│") || line.startsWith("└"));
    const widths = new Set(rows.map((line) => visibleWidth(line)));
    expect(widths.size).toBe(1);
  });
});

describe("markdown — wrapping never splits an OSC 8 sequence", () => {
  const doc = "Prefix text here [a very long link label that will certainly wrap](https://example.com/some/deep/path) tail.";

  it("closes the link at end of row and re-opens it on the next", () => {
    const out = renderMarkdown(doc, { width: 40, hyperlinks: true });
    const lines = out.replace(/\n$/, "").split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      // No half sequence anywhere: every OSC introducer on a line is matched
      // by a terminator on that same line.
      expect((line.match(/\x1b\]8;/g) ?? []).length)
        .toBe((line.match(/\x1b\\/g) ?? []).length);
      // …and the row is balanced: as many closes as opens.
      const { opens, closes } = linkRegions(line);
      expect(closes).toBe(opens.length);
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(stripAnsi(out).replace(/\n/g, " ").trim())
      .toBe("Prefix text here a very long link label that will certainly wrap (https://example.com/some/deep/path) tail.");
  });

  it("keeps a block quote's `│ ` prefix OUTSIDE the link region", () => {
    // renderQuote glues the bar on *after* wrapping. Without the per-row
    // re-open the bar (and the space after it) would land inside the still
    // open hyperlink and become clickable.
    const out = renderMarkdown(
      "> See [docs](https://example.com/a/very/long/path/that/wraps) for a lot more information here.\n",
      { width: 40, hyperlinks: true }
    );
    for (const line of out.replace(/\n+$/, "").split("\n")) {
      const barIndex = line.indexOf("│");
      const firstOpen = line.indexOf("\x1b]8;");
      if (firstOpen >= 0) expect(firstOpen).toBeGreaterThan(barIndex);
      const { opens, closes } = linkRegions(line);
      expect(closes).toBe(opens.length);
    }
  });

  it("reopenHyperlinksPerLine puts the re-open after the hanging indent", () => {
    const open = OPEN("https://example.com");
    const rows = __test.reopenHyperlinksPerLine([`a ${open}bb`, "  cc", "  dd"]);
    expect(rows[0]).toBe(`a ${open}bb${CLOSE}`);
    expect(rows[1]).toBe(`  ${open}cc${CLOSE}`);
    expect(rows[2]).toBe(`  ${open}dd${CLOSE}`);
    // Indent is not clickable.
    expect(rows[1].indexOf("\x1b]8;")).toBe(2);
  });

  it("stops re-opening once the link closes", () => {
    const open = OPEN("https://example.com");
    const rows = __test.reopenHyperlinksPerLine([`${open}a${CLOSE}`, "plain"]);
    expect(rows).toEqual([`${open}a${CLOSE}`, "plain"]);
  });
});
