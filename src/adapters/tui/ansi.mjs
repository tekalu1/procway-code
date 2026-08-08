/**
 * Minimal ANSI helpers used by adapters/tui/* renderers. No external
 * dependencies — escape sequences are written directly so the bundle size
 * stays at zero new runtime deps (Phase 5 §2.2 decision).
 *
 * The helpers are intentionally pure: each function takes a string and
 * returns a string. cli.mjs is the only caller that decides where the
 * resulting bytes are written, which keeps the streaming write path
 * collapsed to a single sink (Phase 5 brief §4 — avoid hotfix 294f143
 * recurrence).
 *
 * Phase 0 (TUI hardening) changes:
 *  - styles close with their *specific* off-code (SGR 22/23/24/39/49) instead
 *    of a blanket `ESC[0m`, and a nested identical close is re-opened, so
 *    `bold(color("blue", "a" + bold("b") + "c"))` keeps the blue and the outer
 *    bold alive after the inner span closes.
 *  - the palette is one table shared by every renderer: named 16-colour
 *    entries *and* named 256-colour entries (`accent`, `muted`, …) that the
 *    welcome banner in shell.mjs used to keep in a private copy.
 *  - `visibleWidth` measures grapheme clusters (emoji, ZWJ sequences,
 *    combining marks, CJK) rather than code points.
 *  - `supportsColor()` is the single place that interprets NO_COLOR /
 *    FORCE_COLOR / TERM / COLORTERM.
 */

export const ESC = "\x1b";

/**
 * Foreground palette. Values are raw SGR parameter strings so 16-colour and
 * 256-colour entries can live in one table (`38;5;n` = 256-colour foreground).
 * Every entry closes with SGR 39 ("default foreground").
 */
const COLORS = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
  gray: "90",
  brightRed: "91",
  brightGreen: "92",
  brightYellow: "93",
  brightBlue: "94",
  brightMagenta: "95",
  brightCyan: "96",
  // 256-colour brand palette (previously private to adapters/tui/shell.mjs).
  accent: "38;5;141",
  accentStrong: "38;5;177",
  muted: "38;5;245",
  success: "38;5;114",
  warning: "38;5;221",
  danger: "38;5;203"
};

const BG_COLORS = {
  black: "40",
  red: "41",
  green: "42",
  yellow: "43",
  blue: "44",
  magenta: "45",
  cyan: "46",
  white: "47",
  gray: "100"
};

const CLOSE_FG = `${ESC}[39m`;
const CLOSE_BG = `${ESC}[49m`;
const CLOSE_INTENSITY = `${ESC}[22m`;
const CLOSE_ITALIC = `${ESC}[23m`;
const CLOSE_UNDERLINE = `${ESC}[24m`;
const CLOSE_STRIKE = `${ESC}[29m`;

/**
 * Wrap `text` in an open/close SGR pair. Any occurrence of the *same* close
 * sequence already inside `text` (an inner span of the same attribute) is
 * rewritten to the open sequence, so the attribute survives until the outer
 * close. This is what keeps nesting from collapsing (P0-5).
 */
function wrap(open, close, text) {
  const value = String(text ?? "");
  if (value.length === 0) return `${open}${close}`;
  const body = value.includes(close) ? value.split(close).join(open) : value;
  return `${open}${body}${close}`;
}

/** Look up a palette entry; returns null for unknown names. */
export function colorCode(name) {
  return COLORS[name] ?? null;
}

export function color(name, text) {
  const code = COLORS[name];
  if (code == null) return text;
  return wrap(`${ESC}[${code}m`, CLOSE_FG, text);
}

/** 256-colour foreground escape for callers that need an ad-hoc shade. */
export function color256(index, text) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n > 255) return text;
  return wrap(`${ESC}[38;5;${n}m`, CLOSE_FG, text);
}

export function bgColor(name, text) {
  const code = BG_COLORS[name];
  if (code == null) return text;
  return wrap(`${ESC}[${code}m`, CLOSE_BG, text);
}

export function bold(text) {
  return wrap(`${ESC}[1m`, CLOSE_INTENSITY, text);
}

export function dim(text) {
  return wrap(`${ESC}[2m`, CLOSE_INTENSITY, text);
}

export function italic(text) {
  return wrap(`${ESC}[3m`, CLOSE_ITALIC, text);
}

export function underline(text) {
  return wrap(`${ESC}[4m`, CLOSE_UNDERLINE, text);
}

/**
 * SGR 9 / 29. Not every terminal draws SGR 9 (legacy conhost and a few
 * minimal emulators drop it), and a dropped strikethrough is *invisible* —
 * the text reads as ordinary prose and the "this was retracted" meaning is
 * gone. Callers therefore pair it with `dim()` (see markdown-render's
 * `renderInline`), which every terminal honours and which carries the same
 * "de-emphasised" reading.
 */
export function strikethrough(text) {
  return wrap(`${ESC}[9m`, CLOSE_STRIKE, text);
}

/**
 * Apply several palette/attribute names at once, e.g.
 * `style(["accentStrong", "bold"], " procway-code ")`. Unknown names are
 * ignored. Styles are applied outermost-first so the nesting fixups above
 * still hold.
 */
export function style(names, text) {
  const list = Array.isArray(names) ? names : [names];
  let out = String(text ?? "");
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const name = list[index];
    if (name === "bold") out = bold(out);
    else if (name === "dim") out = dim(out);
    else if (name === "italic") out = italic(out);
    else if (name === "underline") out = underline(out);
    else if (name === "strikethrough" || name === "strike") out = strikethrough(out);
    else if (COLORS[name]) out = color(name, out);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * OSC 8 hyperlinks (P3d-3)
 * ------------------------------------------------------------------ */

/**
 * `ESC ] 8 ; params ; URI ST` … `ESC ] 8 ; ; ST`, where ST is either the
 * 7-bit string terminator `ESC \` or the legacy `BEL`. Both terminators are
 * accepted on the way *in* (we may be measuring somebody else's bytes); we
 * only ever emit `ESC \`.
 *
 * Every zero-width-escape consumer in the TUI shares this one pattern source.
 * Before Phase 3d `ANSI_RE` matched CSI SGR only, so a single OSC 8 link made
 * `visibleWidth` over-count by the length of the URI — which would have
 * corrupted wrapping, table column sizing, panel borders and the line
 * editor's cursor arithmetic the moment we started emitting links.
 */
const OSC_SOURCE = "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)";
const SGR_SOURCE = "\\x1b\\[[0-9;]*m";
/** Any escape sequence the renderers treat as zero width. */
export const ANSI_SOURCE = `${OSC_SOURCE}|${SGR_SOURCE}`;

const ANSI_RE = new RegExp(ANSI_SOURCE, "g");
const OSC8_RE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** The sequence that ends a hyperlink region. */
export const HYPERLINK_CLOSE = `${ESC}]8;;${ESC}\\`;

/**
 * Reject anything that must never become a clickable target.
 *
 * The URI comes from *model output*, so a hyperlink whose visible text and
 * whose destination disagree is a phishing primitive. Two defences:
 *
 *  - a scheme allowlist — `http` / `https` only. `javascript:`, `data:`,
 *    `file:`, `vscode:` … are never linkified (they stay plain text);
 *  - no control characters or whitespace. `ESC`, `BEL` and newline would
 *    terminate the OSC early and let the rest of the "URI" be interpreted as
 *    terminal commands; a raw space is not legal in a URI anyway;
 *  - none of the characters RFC 3986 excludes from a URI (`< > " ` ^ { } | \`).
 *    This is ordinary URI hygiene, and since Phase 3e it also keeps the
 *    control-character rule above reachable: `sanitize.mjs` neutralises
 *    external text *before* the Markdown parser sees it, so a link written as
 *    `https://evil.com/<BEL>boom` arrives here as `https://evil.com/^Gboom`.
 *    The raw BEL is already gone — nothing can terminate the OSC early any
 *    more — but a URI that HAD a control character in it is a forgery signal
 *    in its own right, and the `^` left behind is the tell. It stays plain
 *    text, exactly as it did before the sanitiser existed.
 */
export function isSafeHyperlinkUri(uri) {
  if (typeof uri !== "string") return false;
  if (uri.length === 0 || uri.length > 2048) return false;
  // C0 controls (ESC / BEL / CR / LF), space and DEL — all of them would
  // terminate the OSC early and hand the rest to the terminal parser.
  if (/[\u0000-\u0020\u007f]/.test(uri)) return false;
  // RFC 3986 "unwise" + delims — also the residue a sanitised control
  // character (`^G`) or a sanitised bidi override (`<U+202E>`) leaves behind.
  if (/[<>"`^{}|\\]/.test(uri)) return false;
  return /^https?:\/\/./i.test(uri);
}

/**
 * Wrap `text` in an OSC 8 hyperlink pointing at `uri`. Returns `text`
 * unchanged when the URI fails {@link isSafeHyperlinkUri}, so an unsafe link
 * degrades to plain text instead of vanishing.
 */
export function hyperlink(uri, text) {
  const label = String(text ?? "");
  if (!isSafeHyperlinkUri(uri)) return label;
  return `${ESC}]8;;${uri}${ESC}\\${label}${HYPERLINK_CLOSE}`;
}

/**
 * Terminals known to implement OSC 8. There is no query for it — a terminal
 * that does not understand the sequence answers nothing — so this is an
 * environment allowlist, and everything not on it falls back to the plain
 * `text (url)` form.
 *
 * `Apple_Terminal` is deliberately absent: Terminal.app has never implemented
 * OSC 8 (it auto-detects bare URLs instead, which the fallback form gives it).
 */
export function supportsHyperlinks(stream = process.stdout, env = process.env) {
  const environment = env ?? {};
  const force = environment.FORCE_HYPERLINK;
  if (typeof force === "string" && force !== "") {
    return !(force === "0" || force === "false");
  }
  // No colour (NO_COLOR, a pipe, TERM=dumb) means no escape sequences at all:
  // a link written into a log file is noise at best.
  if (!supportsColor(stream, environment)) return false;

  const term = typeof environment.TERM === "string" ? environment.TERM : "";
  if (term === "linux") return false; // the kernel console ignores OSC entirely

  if (environment.WT_SESSION) return true; // Windows Terminal
  if (environment.KONSOLE_VERSION) return true;
  if (environment.DOMTERM) return true;
  if (environment.KITTY_WINDOW_ID || term === "xterm-kitty") return true;

  const program = typeof environment.TERM_PROGRAM === "string" ? environment.TERM_PROGRAM : "";
  if (["iTerm.app", "WezTerm", "vscode", "Hyper", "ghostty", "rio", "tabby"].includes(program)) {
    return true;
  }

  // GNOME Terminal / Tilix / xfce4-terminal and friends. VTE gained OSC 8 in
  // 0.50 (VTE_VERSION 5000).
  const vte = Number(environment.VTE_VERSION);
  if (Number.isFinite(vte) && vte >= 5000) return true;

  return false;
}

/**
 * Resolve the effective hyperlink decision: an explicit `true` / `false` in
 * settings wins, `"auto"` (or nothing) probes the environment.
 */
export function resolveHyperlinks(preference, stream = process.stdout, env = process.env) {
  if (preference === true || preference === false) return preference;
  return supportsHyperlinks(stream, env);
}

export function stripAnsi(text) {
  if (typeof text !== "string") return text;
  return text.replace(ANSI_RE, "");
}

const PLACEHOLDER_BY_CODE = new Map([
  ["0", "[/]"],
  ["1", "[bold]"],
  ["2", "[dim]"],
  ["3", "[italic]"],
  ["4", "[underline]"],
  ["9", "[strike]"],
  ["22", "[/intensity]"],
  ["23", "[/italic]"],
  ["24", "[/underline]"],
  ["29", "[/strike]"],
  ["39", "[/color]"],
  ["49", "[/bg]"]
]);

for (const [name, code] of Object.entries(COLORS)) {
  if (!PLACEHOLDER_BY_CODE.has(code)) PLACEHOLDER_BY_CODE.set(code, `[${name}]`);
}
for (const [name, code] of Object.entries(BG_COLORS)) {
  if (!PLACEHOLDER_BY_CODE.has(code)) PLACEHOLDER_BY_CODE.set(code, `[bg-${name}]`);
}

/**
 * Convert ANSI escape sequences to a `[name]...[/name]` placeholder format
 * used by snapshot tests. Helps reviewers read the saved output without
 * fighting `\x1b[...m` noise.
 *
 * OSC 8 renders as `[link=URI]…[/link]` so a snapshot shows *what a link
 * points at* — the one property a reviewer has to be able to check by eye.
 */
export function ansiToPlaceholders(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\x1b\[2K/g, "[clear-line]")
    .replace(OSC8_RE, (_, uri) => (uri ? `[link=${uri}]` : "[/link]"))
    .replace(new RegExp(OSC_SOURCE, "g"), "[osc]")
    .replace(/\x1b\[([0-9;]*)m/g, (_, code) => {
      const key = code === "" ? "0" : code;
      const known = PLACEHOLDER_BY_CODE.get(key);
      if (known) return known;
      return `[ansi:${key}]`;
    });
}

/* ------------------------------------------------------------------ *
 * Width measurement
 * ------------------------------------------------------------------ */

const ZWJ = 0x200d;

function isCombining(code) {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacriticals
    (code >= 0x0483 && code <= 0x0489) ||
    (code >= 0x0591 && code <= 0x05bd) ||
    (code >= 0x0610 && code <= 0x061a) ||
    (code >= 0x064b && code <= 0x065f) ||
    (code >= 0x0e31 && code <= 0x0e3a) ||
    (code >= 0x1ab0 && code <= 0x1aff) || // combining diacriticals extended
    (code >= 0x1dc0 && code <= 0x1dff) || // combining diacriticals supplement
    (code >= 0x20d0 && code <= 0x20f0) || // combining marks for symbols
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) || // combining half marks
    code === 0x200b || // zero-width space
    code === 0x200c || // ZWNJ
    code === ZWJ ||
    code === 0xfeff || // BOM / zero-width no-break space
    (code >= 0xe0100 && code <= 0xe01ef) // variation selectors supplement
  );
}

function isRegionalIndicator(code) {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

/**
 * Emoji-presentation ranges inside U+2600–U+27BF and friends. The whole block
 * is NOT wide: `✓ U+2713` / `✗ U+2717` are East-Asian *ambiguous* and render
 * narrow in every terminal we target (and are used by the tool activity line),
 * so only the Emoji_Presentation=Yes ranges are listed here.
 */
const WIDE_SYMBOL_RANGES = [
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55]
];

function isWideSymbol(code) {
  for (const [start, end] of WIDE_SYMBOL_RANGES) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

/** Width of a single code point (no cluster context). Exported for tests. */
export function charWidth(char) {
  const code = typeof char === "number" ? char : (char?.codePointAt?.(0) ?? 0);
  if (code === 0) return 0;
  if (isCombining(code)) return 0;
  // Rough East-Asian wide handling — sufficient for table column sizing.
  if (code >= 0x1100 && code <= 0x115f) return 2;
  if (isWideSymbol(code)) return 2;
  if (code >= 0x2e80 && code <= 0x303e) return 2;
  if (code >= 0x3041 && code <= 0x33ff) return 2;
  if (code >= 0x3400 && code <= 0x4dbf) return 2;
  if (code >= 0x4e00 && code <= 0x9fff) return 2;
  if (code >= 0xa000 && code <= 0xa4cf) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe4f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  if (isRegionalIndicator(code)) return 2; // flags: one cluster = one glyph
  if (code >= 0x1f300 && code <= 0x1faff) return 2; // emoji planes
  if (code >= 0x1f004 && code <= 0x1f0cf) return 2; // mahjong / playing cards
  if (code >= 0x1f18e && code <= 0x1f1ad) return 2; // enclosed alphanumerics
  if (code >= 0x20000 && code <= 0x3fffd) return 2; // CJK extension B+
  return 1;
}

const defaultSegmenter = (() => {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return new Intl.Segmenter("en", { granularity: "grapheme" });
    }
  } catch {
    /* fall through to the manual grouping below */
  }
  return null;
})();

/**
 * Split into grapheme clusters. Uses Intl.Segmenter (Node 20+, no extra
 * dependency) and falls back to a hand-rolled grouping that joins combining
 * marks, ZWJ sequences and regional-indicator pairs. Pass `segmenter: null`
 * to exercise the fallback (small-icu builds take that path).
 */
export function graphemes(text, { segmenter = defaultSegmenter } = {}) {
  const value = String(text ?? "");
  if (value.length === 0) return [];
  if (segmenter) return Array.from(segmenter.segment(value), (s) => s.segment);

  const clusters = [];
  let current = "";
  let previous = -1;
  let regionalRun = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const joinsPrevious =
      current.length > 0 &&
      (isCombining(code) ||
        previous === ZWJ ||
        (isRegionalIndicator(code) && isRegionalIndicator(previous) && regionalRun % 2 === 1));
    if (joinsPrevious) {
      current += char;
    } else {
      if (current) clusters.push(current);
      current = char;
      regionalRun = 0;
    }
    regionalRun = isRegionalIndicator(code) ? regionalRun + 1 : 0;
    previous = code;
  }
  if (current) clusters.push(current);
  return clusters;
}

/** Width of one grapheme cluster. */
function clusterWidth(cluster) {
  let width = 0;
  let sawEmojiPresentation = false;
  let sawZwj = false;
  for (const char of cluster) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0xfe0f) sawEmojiPresentation = true;
    if (code === ZWJ) sawZwj = true;
    if (width === 0) width = charWidth(code);
  }
  // A cluster with no visible base (a lone ZWJ / combining mark) stays zero.
  if (width === 0) return 0;
  // ZWJ sequences (👨‍👩‍👧) and text glyphs promoted to emoji presentation
  // (1️⃣) render as one double-width glyph.
  if (sawZwj || sawEmojiPresentation) return 2;
  return width;
}

export function visibleWidth(text) {
  if (typeof text !== "string") return 0;
  return graphemes(stripAnsi(text)).reduce((width, cluster) => width + clusterWidth(cluster), 0);
}

export function padEnd(text, width) {
  const current = visibleWidth(text);
  if (current >= width) return text;
  return text + " ".repeat(width - current);
}

/**
 * Truncate to `width` visible columns, appending `ellipsis` when the text does
 * not fit. Never splits a grapheme cluster and accounts for double-width
 * glyphs (so a CJK/emoji cwd can no longer push the welcome box open).
 */
export function truncateToWidth(text, width, ellipsis = "…") {
  const value = String(text ?? "");
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  const markWidth = visibleWidth(ellipsis);
  if (width <= markWidth) return ellipsis.slice(0, 1);
  const budget = width - markWidth;
  let out = "";
  let used = 0;
  for (const cluster of graphemes(stripAnsi(value))) {
    const w = clusterWidth(cluster);
    if (used + w > budget) break;
    out += cluster;
    used += w;
  }
  return `${out}${ellipsis}`;
}

/* ------------------------------------------------------------------ *
 * Colour capability detection
 * ------------------------------------------------------------------ */

/**
 * Colour support level for a stream: 0 = none, 1 = 16 colours,
 * 2 = 256 colours, 3 = truecolor.
 *
 * Precedence (documented so callers stop hand-rolling `isTTY === true`):
 *   1. `NO_COLOR` (present and non-empty) wins — always 0, per no-color.org
 *      and chalk's behaviour.
 *   2. `FORCE_COLOR` — `0`/`false` disables, otherwise forces on
 *      (`1`/`true` → 16, `2` → 256, `3` → truecolor).
 *   3. `TERM=dumb` → 0.
 *   4. Non-TTY stream → 0.
 *   5. Otherwise derive from `COLORTERM` / `TERM`.
 */
/**
 * The terminal's usable width, with the pathological cases folded in.
 *
 * `stream.columns ?? 80` is NOT enough: a pty created without a size (which is
 * what `script -qec … /dev/null` and several CI harnesses do) reports
 * `columns === 0`, and `0 ?? 80` is `0` — every panel then wrapped to a
 * single character per row. Anything non-positive falls back; anything
 * absurdly narrow is floored so the layout degrades instead of collapsing.
 */
export function terminalWidth(stream = process.stdout, { fallback = 80, min = 20 } = {}) {
  const columns = Number(stream?.columns);
  if (!Number.isFinite(columns) || columns <= 0) return fallback;
  return Math.max(min, Math.floor(columns));
}

/** The terminal's usable height, same caveats as {@link terminalWidth}. */
export function terminalHeight(stream = process.stdout, { fallback = 24, min = 6 } = {}) {
  const rows = Number(stream?.rows);
  if (!Number.isFinite(rows) || rows <= 0) return fallback;
  return Math.max(min, Math.floor(rows));
}

export function colorLevel(stream = process.stdout, env = process.env) {
  const environment = env ?? {};
  const noColor = environment.NO_COLOR;
  if (typeof noColor === "string" && noColor !== "") return 0;

  const force = environment.FORCE_COLOR;
  if (typeof force === "string") {
    if (force === "0" || force === "false") return 0;
    if (force === "2") return 2;
    if (force === "3") return 3;
    return 1;
  }

  const term = typeof environment.TERM === "string" ? environment.TERM : "";
  if (term === "dumb") return 0;
  if (!stream || stream.isTTY !== true) return 0;

  const colorTerm = typeof environment.COLORTERM === "string" ? environment.COLORTERM : "";
  if (colorTerm === "truecolor" || colorTerm === "24bit") return 3;
  if (/-256(color)?$/i.test(term)) return 2;
  if (colorTerm !== "") return 1;
  if (term === "") return 1;
  return 1;
}

/** Single source of truth for "should this stream get ANSI colour?". */
export function supportsColor(stream = process.stdout, env = process.env) {
  return colorLevel(stream, env) > 0;
}
