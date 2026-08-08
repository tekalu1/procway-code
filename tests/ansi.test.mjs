import { describe, expect, it } from "vitest";
import {
  ansiToPlaceholders,
  bold,
  color,
  color256,
  colorLevel,
  dim,
  graphemes,
  hyperlink,
  HYPERLINK_CLOSE,
  isSafeHyperlinkUri,
  italic,
  padEnd,
  resolveHyperlinks,
  stripAnsi,
  strikethrough,
  style,
  supportsColor,
  supportsHyperlinks,
  truncateToWidth,
  underline,
  visibleWidth
} from "../src/adapters/tui/ansi.mjs";

const tty = { isTTY: true };
const pipe = { isTTY: false };

/** The two legal OSC terminators: `ESC \` (ST) and BEL. */
const link = (uri, text) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
const linkBel = (uri, text) => `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;

describe("ansi — visibleWidth (grapheme aware)", () => {
  it("counts ASCII and CJK", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("日本語")).toBe(6);
    expect(visibleWidth("ｆｕｌｌ")).toBe(8);
    expect(visibleWidth("한국어")).toBe(6);
  });

  it("counts emoji as two columns", () => {
    expect(visibleWidth("👍")).toBe(2);
    expect(visibleWidth("🚀🚀")).toBe(4);
    expect(visibleWidth("✨")).toBe(2);
  });

  it("counts a ZWJ sequence as a single two-column glyph", () => {
    expect(visibleWidth("👨‍👩‍👧")).toBe(2);
    expect(graphemes("👨‍👩‍👧")).toHaveLength(1);
    expect(visibleWidth("a👨‍👩‍👧b")).toBe(4);
  });

  it("counts a regional-indicator flag pair as one glyph", () => {
    expect(visibleWidth("🇯🇵")).toBe(2);
  });

  it("groups the same clusters without Intl.Segmenter (small-icu fallback)", () => {
    const manual = (text) => graphemes(text, { segmenter: null });
    expect(manual("👨‍👩‍👧")).toEqual(["👨‍👩‍👧"]);
    expect(manual("🇯🇵🇯🇵")).toEqual(["🇯🇵", "🇯🇵"]);
    expect(manual("é")).toEqual(["é"]);
    expect(manual("a👍b")).toEqual(["a", "👍", "b"]);
    expect(manual("1️⃣")).toEqual(["1️⃣"]);
  });

  it("gives combining marks zero width", () => {
    expect(visibleWidth("é")).toBe(1); // e + combining acute
    expect(visibleWidth("à́")).toBe(1);
    expect(visibleWidth("‍")).toBe(0);
  });

  it("treats an emoji variation selector as a wide glyph", () => {
    expect(visibleWidth("1️⃣")).toBe(2);
  });

  it("keeps narrow the ambiguous-width marks the TUI relies on", () => {
    // ✓ / ✗ / ● live near the emoji block but render single-width.
    expect(visibleWidth("✓")).toBe(1);
    expect(visibleWidth("✗")).toBe(1);
    expect(visibleWidth("●")).toBe(1);
    expect(visibleWidth("│─╭╮╰╯")).toBe(6);
  });

  it("ignores ANSI escapes", () => {
    expect(visibleWidth(bold(color("blue", "日本語")))).toBe(6);
  });

  // Before Phase 3d `ANSI_RE` was SGR-only, so `visibleWidth` on the sequence
  // below returned 31 (the whole URI counted as columns) instead of 4. Every
  // wrap, table column, panel border and cursor column in the TUI is derived
  // from this function, so emitting a link without this fix would have skewed
  // all of them at once.
  it("gives an OSC 8 hyperlink zero width (both ST and BEL terminators)", () => {
    expect(stripAnsi(link("https://x.com", "link"))).toBe("link");
    expect(visibleWidth(link("https://x.com", "link"))).toBe(4);
    expect(stripAnsi(linkBel("https://x.com", "link"))).toBe("link");
    expect(visibleWidth(linkBel("https://x.com", "link"))).toBe(4);
    // Mixed with SGR, and with a wide label.
    expect(visibleWidth(link("https://x.com", bold("日本語")))).toBe(6);
    // A bare close carries no width either.
    expect(visibleWidth(HYPERLINK_CLOSE)).toBe(0);
  });
});

describe("ansi — padEnd / truncateToWidth", () => {
  it("pads by visible columns", () => {
    expect(visibleWidth(padEnd("日本", 10))).toBe(10);
    expect(visibleWidth(padEnd("👍", 10))).toBe(10);
  });

  it("truncates on column budget, never mid-cluster", () => {
    expect(truncateToWidth("abcdef", 10)).toBe("abcdef");
    expect(truncateToWidth("abcdef", 4)).toBe("abc…");
    expect(visibleWidth(truncateToWidth("日本語のディレクトリ", 9))).toBe(9);
    expect(truncateToWidth("👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", 5)).toBe("👨‍👩‍👧👨‍👩‍👧…");
    expect(truncateToWidth("abc", 0)).toBe("");
  });

  it("measures a hyperlink by its label when padding and truncating", () => {
    const cell = link("https://example.com/a/very/long/path", "docs");
    expect(visibleWidth(padEnd(cell, 10))).toBe(10);
    // A cell that already fits is returned untouched — the link survives.
    expect(truncateToWidth(cell, 10)).toBe(cell);
    // One that does not fit is truncated on the *label*, and the escape (and
    // with it the clickable target) is dropped rather than half-emitted.
    expect(truncateToWidth(cell, 3)).toBe("do…");
  });
});

describe("ansi — nesting", () => {
  it("closes each attribute with its own off-code, not a blanket reset", () => {
    expect(bold("x")).toBe("\x1b[1mx\x1b[22m");
    expect(dim("x")).toBe("\x1b[2mx\x1b[22m");
    expect(italic("x")).toBe("\x1b[3mx\x1b[23m");
    expect(underline("x")).toBe("\x1b[4mx\x1b[24m");
    expect(strikethrough("x")).toBe("\x1b[9mx\x1b[29m");
    expect(color("blue", "x")).toBe("\x1b[34mx\x1b[39m");
  });

  it("keeps the outer strikethrough alive across a nested one (SGR 29 close)", () => {
    const out = strikethrough(`a${strikethrough("b")}c`);
    expect(out).toBe("\x1b[9ma\x1b[9mb\x1b[9mc\x1b[29m");
    expect(out).not.toContain("\x1b[0m");
    expect(stripAnsi(out)).toBe("abc");
  });

  it("keeps an outer colour and underline alive around a strikethrough span", () => {
    const out = color("cyan", `a${underline(strikethrough("b"))}c`);
    expect(out).toBe("\x1b[36ma\x1b[4m\x1b[9mb\x1b[29m\x1b[24mc\x1b[39m");
    expect(ansiToPlaceholders(out)).toBe("[cyan]a[underline][strike]b[/strike][/underline]c[/color]");
  });

  it("exposes strikethrough through style()", () => {
    expect(style(["danger", "strikethrough"], "t")).toBe("\x1b[38;5;203m\x1b[9mt\x1b[29m\x1b[39m");
    expect(style("strike", "t")).toBe("\x1b[9mt\x1b[29m");
  });

  it("keeps the outer colour alive after an inner bold span closes", () => {
    const out = bold(color("blue", `## A ${bold("bold")} tail here`));
    // No blanket reset anywhere — the colour close is the very last sequence
    // before the bold close.
    expect(out).not.toContain("\x1b[0m");
    expect(out.endsWith("\x1b[39m\x1b[22m")).toBe(true);
    // The inner bold close was rewritten to the outer open, so "tail here" is
    // still inside both the blue and the bold spans.
    expect(out).toBe("\x1b[1m\x1b[34m## A \x1b[1mbold\x1b[1m tail here\x1b[39m\x1b[22m");
  });

  it("keeps an inner colour from killing the outer colour", () => {
    const out = color("green", `a${color("red", "b")}c`);
    expect(out).toBe("\x1b[32ma\x1b[31mb\x1b[32mc\x1b[39m");
  });

  it("round-trips through stripAnsi and ansiToPlaceholders", () => {
    const out = bold(color("blue", `## A ${bold("bold")} tail here`));
    expect(stripAnsi(out)).toBe("## A bold tail here");
    expect(ansiToPlaceholders(out)).toBe("[bold][blue]## A [bold]bold[bold] tail here[/color][/intensity]");
    expect(ansiToPlaceholders(color("accent", "x"))).toBe("[accent]x[/color]");
    expect(ansiToPlaceholders("\x1b[2Kx")).toBe("[clear-line]x");
  });
});

describe("ansi — shared palette", () => {
  it("exposes the 256-colour brand entries through color()", () => {
    expect(color("accent", "x")).toBe("\x1b[38;5;141mx\x1b[39m");
    expect(color("muted", "x")).toBe("\x1b[38;5;245mx\x1b[39m");
    expect(color256(203, "x")).toBe("\x1b[38;5;203mx\x1b[39m");
    expect(color256(999, "x")).toBe("x");
    expect(color("nope", "x")).toBe("x");
  });

  it("composes several styles outermost-first", () => {
    expect(style(["accentStrong", "bold"], "t")).toBe("\x1b[38;5;177m\x1b[1mt\x1b[22m\x1b[39m");
    expect(style("bold", "t")).toBe("\x1b[1mt\x1b[22m");
    expect(style(["unknown"], "t")).toBe("t");
  });
});

describe("ansi — OSC 8 hyperlinks", () => {
  it("emits the ST-terminated form and round-trips through the helpers", () => {
    const out = hyperlink("https://example.com/docs", "docs");
    expect(out).toBe("\x1b]8;;https://example.com/docs\x1b\\docs\x1b]8;;\x1b\\");
    expect(stripAnsi(out)).toBe("docs");
    expect(visibleWidth(out)).toBe(4);
    expect(ansiToPlaceholders(out)).toBe("[link=https://example.com/docs]docs[/link]");
  });

  // The URI comes from model output, so a link whose destination disagrees
  // with its visible text is a phishing primitive. Only http(s) is clickable.
  it("allowlists http/https and refuses every other scheme", () => {
    expect(isSafeHyperlinkUri("https://example.com")).toBe(true);
    expect(isSafeHyperlinkUri("http://example.com/a?b=c#d")).toBe(true);
    expect(isSafeHyperlinkUri("HTTPS://EXAMPLE.COM")).toBe(true);
    for (const uri of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vscode://file/etc/passwd",
      "mailto:a@b.c",
      "//example.com",
      "example.com",
      "https://",
      ""
    ]) {
      expect(isSafeHyperlinkUri(uri), uri).toBe(false);
      expect(hyperlink(uri, "label")).toBe("label"); // degrades to plain text
    }
  });

  it("refuses a URI carrying control characters or spaces (OSC escape hatch)", () => {
    for (const uri of [
      "https://evil.com/\x1b]0;pwned\x07",   // ESC would end the OSC early
      "https://evil.com/\x07rest",            // BEL likewise
      "https://evil.com/\nX",
      "https://evil.com/\r\nX",
      "https://evil.com/a b",
      "https://evil.com/\x7f"
    ]) {
      expect(isSafeHyperlinkUri(uri), JSON.stringify(uri)).toBe(false);
      expect(hyperlink(uri, "label")).toBe("label");
    }
    expect(isSafeHyperlinkUri(`https://example.com/${"a".repeat(4000)}`)).toBe(false);
  });

  it("detects known OSC 8 terminals and falls back everywhere else", () => {
    const on = { TERM: "xterm-256color" };
    expect(supportsHyperlinks(tty, { ...on, TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(supportsHyperlinks(tty, { ...on, TERM_PROGRAM: "WezTerm" })).toBe(true);
    expect(supportsHyperlinks(tty, { ...on, TERM_PROGRAM: "vscode" })).toBe(true);
    expect(supportsHyperlinks(tty, { ...on, WT_SESSION: "abc" })).toBe(true);
    expect(supportsHyperlinks(tty, { ...on, KONSOLE_VERSION: "220400" })).toBe(true);
    expect(supportsHyperlinks(tty, { ...on, VTE_VERSION: "6003" })).toBe(true);
    expect(supportsHyperlinks(tty, { TERM: "xterm-kitty" })).toBe(true);

    // VTE gained OSC 8 in 0.50; older GNOME Terminals must not get it.
    expect(supportsHyperlinks(tty, { ...on, VTE_VERSION: "4600" })).toBe(false);
    // Terminal.app has never implemented OSC 8 — it auto-detects bare URLs,
    // which is exactly what the `text (url)` fallback gives it.
    expect(supportsHyperlinks(tty, { ...on, TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(supportsHyperlinks(tty, { TERM: "linux" })).toBe(false);
    expect(supportsHyperlinks(tty, on)).toBe(false);
  });

  it("never emits links where colour is off (pipe, NO_COLOR, TERM=dumb)", () => {
    const iterm = { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" };
    expect(supportsHyperlinks(pipe, iterm)).toBe(false);
    expect(supportsHyperlinks(tty, { ...iterm, NO_COLOR: "1" })).toBe(false);
    expect(supportsHyperlinks(tty, { ...iterm, TERM: "dumb" })).toBe(false);
  });

  it("honours FORCE_HYPERLINK above the allowlist", () => {
    expect(supportsHyperlinks(pipe, { FORCE_HYPERLINK: "1" })).toBe(true);
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color", FORCE_HYPERLINK: "0" })).toBe(false);
    expect(supportsHyperlinks(tty, { TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color", FORCE_HYPERLINK: "false" })).toBe(false);
  });

  it("lets an explicit settings value win over detection", () => {
    const noLinks = { TERM: "xterm-256color" };
    expect(resolveHyperlinks(true, pipe, noLinks)).toBe(true);
    expect(resolveHyperlinks(false, tty, { ...noLinks, TERM_PROGRAM: "iTerm.app" })).toBe(false);
    expect(resolveHyperlinks("auto", tty, { ...noLinks, TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(resolveHyperlinks(undefined, tty, noLinks)).toBe(false);
  });
});

describe("ansi — supportsColor", () => {
  it("colours an interactive terminal and skips a pipe", () => {
    expect(supportsColor(tty, { TERM: "xterm-256color" })).toBe(true);
    expect(supportsColor(pipe, { TERM: "xterm-256color" })).toBe(false);
  });

  it("honours NO_COLOR above everything else", () => {
    expect(supportsColor(tty, { NO_COLOR: "1" })).toBe(false);
    expect(supportsColor(tty, { NO_COLOR: "anything" })).toBe(false);
    expect(supportsColor(tty, { NO_COLOR: "1", FORCE_COLOR: "3" })).toBe(false);
    // An empty NO_COLOR is not set, per no-color.org.
    expect(supportsColor(tty, { NO_COLOR: "" })).toBe(true);
  });

  it("honours FORCE_COLOR on a pipe and its 0/false opt-out", () => {
    expect(supportsColor(pipe, { FORCE_COLOR: "1" })).toBe(true);
    expect(supportsColor(pipe, { FORCE_COLOR: "" })).toBe(true);
    expect(supportsColor(tty, { FORCE_COLOR: "0" })).toBe(false);
    expect(supportsColor(tty, { FORCE_COLOR: "false" })).toBe(false);
  });

  it("treats TERM=dumb as colourless unless forced", () => {
    expect(supportsColor(tty, { TERM: "dumb" })).toBe(false);
    expect(supportsColor(tty, { TERM: "dumb", FORCE_COLOR: "1" })).toBe(true);
  });

  it("reports a capability level from COLORTERM / TERM", () => {
    expect(colorLevel(tty, { TERM: "xterm-256color" })).toBe(2);
    expect(colorLevel(tty, { TERM: "xterm", COLORTERM: "truecolor" })).toBe(3);
    expect(colorLevel(tty, { TERM: "xterm" })).toBe(1);
    expect(colorLevel(pipe, { TERM: "xterm" })).toBe(0);
  });
});
