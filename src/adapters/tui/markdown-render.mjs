import {
  ANSI_SOURCE,
  bold,
  color,
  dim,
  hyperlink,
  HYPERLINK_CLOSE,
  isSafeHyperlinkUri,
  italic,
  strikethrough,
  underline,
  graphemes,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
  padEnd
} from "./ansi.mjs";
import { sanitizeStreamPrefix, sanitizeTerminalText } from "./sanitize.mjs";

/**
 * Markdown → ANSI for terminal output.
 *
 * Phase 1 moved the transcript layer out of this module: `renderTranscript` /
 * `printTranscript` now live in `adapters/tui/transcript-node-render.mjs`,
 * which owns the single node → string dispatch (and imports `renderMarkdown`
 * from here for the assistant case). Keeping the dependency one-way means
 * this file knows nothing about messages, nodes or sessions — and there is no
 * `markdown: boolean` flag left to forget on one of the four replay routes.
 */

/**
 * Render Markdown to an ANSI-coloured string for terminal display.
 *
 * The source is model output, so it is run through
 * `sanitize.mjs#sanitizeTerminalText` before it is parsed (P3e-1) — ahead of
 * every `color()` / `hyperlink()` call, which is the ordering that lets us
 * strip somebody else's `ESC` without eating our own.
 *
 * @param {string} text  Markdown source (full document or pre-flushed slice).
 * @param {{ width?: number, color?: boolean, hyperlinks?: boolean }} [options]
 *        `hyperlinks` turns Markdown links into OSC 8 escapes. It defaults to
 *        `false` because only the *call sites* know whether the terminal on
 *        the other end understands them (`ansi.mjs#resolveHyperlinks`), and a
 *        pure renderer must not sniff `process.env` — live and replayed output
 *        have to agree byte for byte, so both routes must be handed the same
 *        value rather than each deciding for itself.
 * @returns {string}
 */
export function renderMarkdown(text, { width = 80, color: colorize = true, hyperlinks = false } = {}) {
  if (typeof text !== "string") return "";
  return renderMarkdownBlocks(parseBlocks(sanitizeTerminalText(text)), { width, color: colorize, hyperlinks });
}

/**
 * Render an already-parsed block list. `renderMarkdown` is exactly
 * `renderMarkdownBlocks(parseBlocks(text))`, and because every block renders
 * independently the two are *concatenation-equal*: rendering a prefix of the
 * blocks now and the rest later produces the same bytes as one shot. That is
 * what lets the streaming renderer emit finished blocks as they arrive and
 * still match the replayed transcript byte for byte (see `splitReadyBlocks`).
 */
export function renderMarkdownBlocks(blocks, { width = 80, color: colorize = true, hyperlinks = false } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  const out = [];
  for (const block of blocks) {
    out.push(renderBlock(block, { width, colorize, hyperlinks }));
  }
  return out.join("");
}

/**
 * Split a *growing* Markdown source into the blocks whose parse can no longer
 * change, plus the raw remainder.
 *
 * The streaming renderer used to cut its buffer at the last newline and call
 * `renderMarkdown()` on each fragment. `renderMarkdown` treats its argument as
 * a whole document — it emits the trailing blank of the phantom final line —
 * so every fragment added a blank line and the live output drifted from the
 * one-shot replay (a heading + a 2-item list gained four blank lines).
 *
 * The fix is to cut on *block* boundaries instead of newlines:
 *
 *  - only complete lines are considered (everything up to the last `\n`);
 *  - a block that is followed by another block is final by construction —
 *    `parseBlocks` is a forward line scan, so appending lines can never
 *    re-parse it;
 *  - the *last* block is final only if nothing can extend it: headings,
 *    rules, blanks and closed code fences are single-shot, and a list is
 *    safe because `renderList` renders one line per item, so splitting a list
 *    between items concatenates to the same string. Paragraphs, tables,
 *    quotes and open code fences can all absorb the next line, so they wait
 *    (which is also what keeps a half-written ``` fence off the screen);
 *  - trailing blank blocks are held back, so the emitted text never ends with
 *    a blank line. The replayed transcript trims trailing newlines off the
 *    assistant node, and live output can only match that if it never wrote
 *    them in the first place.
 *
 * P3e-1: the buffer is sanitised HERE rather than in `parseBlocks`, because
 * sanitising changes the string's length and the `rest` cut below is a
 * character offset — computing the offset against one string and slicing
 * another would drop or duplicate text. Sanitising the whole growing buffer on
 * every chunk is what closes the "escape split across two deltas" hole: the
 * map is per-character, so an `ESC` alone in one chunk is already neutralised
 * before its `]52;…` payload ever arrives. The single character of look-ahead
 * the map does need (`\r\n`) is held back by `sanitizeStreamPrefix` and
 * re-offered with the next chunk, so a CRLF document streams to the same bytes
 * it replays to.
 *
 * @param {string} source
 * @returns {{ blocks: object[], rest: string }} `rest` is newline-normalised
 *   and sanitised, apart from a deliberately retained trailing `\r`.
 */
export function splitReadyBlocks(source) {
  const { text, pending } = sanitizeStreamPrefix(typeof source === "string" ? source : "");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { blocks: [], rest: `${text}${pending}` };
  const blocks = parseBlocks(text.slice(0, lastNewline));
  let count = 0;
  let consumedLines = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const isLast = index === blocks.length - 1;
    if (isLast && !isSelfTerminating(blocks[index])) break;
    count = index + 1;
    consumedLines += blocks[index].srcLines;
  }
  while (count > 0 && blocks[count - 1].kind === "blank") {
    count -= 1;
    consumedLines -= blocks[count].srcLines;
  }
  if (count === 0) return { blocks: [], rest: `${text}${pending}` };
  let offset = 0;
  for (let line = 0; line < consumedLines; line += 1) {
    offset = text.indexOf("\n", offset) + 1;
  }
  return { blocks: blocks.slice(0, count), rest: `${text.slice(offset)}${pending}` };
}

/** Can appending more lines change this block? (see `splitReadyBlocks`) */
function isSelfTerminating(block) {
  if (!block) return false;
  if (block.kind === "code") return block.closed === true;
  return block.kind !== "paragraph" && block.kind !== "table" && block.kind !== "quote";
}

/** Drop trailing newlines — the shared "a block ends without blank tail" rule. */
export function trimTrailingNewlines(text) {
  return typeof text === "string" ? text.replace(/\n+$/, "") : "";
}

export const __test = { parseBlocks, renderInline, wrap, reopenHyperlinksPerLine };

/**
 * Parse a Markdown source string into a flat list of block descriptors. The
 * grammar is intentionally narrow — we cover the subset the brief calls out
 * (§2.3) and treat anything else as a paragraph. We DO recognise unclosed
 * fenced code blocks so the streaming renderer can defer rendering until the
 * fence closes (Phase 5 §2.4).
 */
function parseBlocks(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const start = index;
    index = parseBlockAt(lines, index, blocks);
    // How many source lines this block ate. `splitReadyBlocks` maps that back
    // to a character offset so the streaming buffer can drop exactly the text
    // it has already rendered.
    blocks[blocks.length - 1].srcLines = index - start;
  }
  return blocks;
}

/** Parse one block starting at `index`, push it, and return the next index. */
function parseBlockAt(lines, index, blocks) {
  const line = lines[index];
  if (/^```/.test(line)) {
    const lang = line.replace(/^```/, "").trim();
    const codeLines = [];
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      if (/^```\s*$/.test(lines[cursor])) {
        closed = true;
        break;
      }
      codeLines.push(lines[cursor]);
      cursor += 1;
    }
    blocks.push({ kind: "code", lang, lines: codeLines, closed });
    return closed ? cursor + 1 : cursor;
  }
  const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
  if (headingMatch) {
    blocks.push({ kind: "heading", level: headingMatch[1].length, text: headingMatch[2] });
    return index + 1;
  }
  if (/^\s*$/.test(line)) {
    blocks.push({ kind: "blank" });
    return index + 1;
  }
  if (isHorizontalRule(line)) {
    blocks.push({ kind: "hr" });
    return index + 1;
  }
  if (isQuote(line)) {
    const quoteLines = [];
    while (index < lines.length && isQuote(lines[index])) {
      quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
      index += 1;
    }
    blocks.push({ kind: "quote", lines: quoteLines });
    return index;
  }
  if (looksLikeTable(lines, index)) {
    const tableLines = [];
    while (index < lines.length && /\|/.test(lines[index]) && !/^\s*$/.test(lines[index])) {
      tableLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "table", lines: tableLines });
    return index;
  }
  if (isListItem(line)) {
    const items = [];
    while (index < lines.length && !isHorizontalRule(lines[index])) {
      const itemMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[index]);
      if (!itemMatch) break;
      const rest = itemMatch[3];
      const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(rest);
      items.push({
        indent: itemMatch[1].length,
        marker: itemMatch[2],
        task: taskMatch ? taskMatch[1].toLowerCase() === "x" : null,
        text: taskMatch ? taskMatch[2] : rest
      });
      index += 1;
    }
    blocks.push({ kind: "list", items });
    return index;
  }
  const paragraphLines = [];
  while (index < lines.length && !isParagraphBreak(lines[index])) {
    paragraphLines.push(lines[index]);
    index += 1;
  }
  blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
  return index;
}

/** `---`, `***`, `___` (optionally spaced) on a line of their own. */
function isHorizontalRule(line) {
  return /^\s{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/.test(line);
}

function isQuote(line) {
  return /^\s{0,3}>/.test(line);
}

function isListItem(line) {
  if (isHorizontalRule(line)) return false;
  return /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
}

/**
 * A paragraph run stops at anything that opens another block. Without this a
 * list written directly under its lead-in sentence (very common in model
 * output) was swallowed into the paragraph and lost its bullets.
 */
function isParagraphBreak(line) {
  return (
    /^\s*$/.test(line) ||
    /^```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    isHorizontalRule(line) ||
    isQuote(line) ||
    isListItem(line)
  );
}

function looksLikeTable(lines, index) {
  if (index + 1 >= lines.length) return false;
  const header = lines[index];
  const separator = lines[index + 1];
  if (!/\|/.test(header)) return false;
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(separator);
}

function renderBlock(block, ctx) {
  if (block.kind === "blank") return "\n";
  if (block.kind === "heading") return renderHeading(block, ctx);
  if (block.kind === "code") return renderCodeBlock(block, ctx);
  if (block.kind === "list") return renderList(block, ctx);
  if (block.kind === "table") return renderTable(block, ctx);
  if (block.kind === "hr") return renderRule(ctx);
  if (block.kind === "quote") return renderQuote(block, ctx);
  return renderParagraph(block, ctx);
}

/**
 * Headings drop their `#` markers when colour is available — the hierarchy is
 * carried by weight/colour instead, which is what a reader expects from a
 * rendered document (P3a-2). Without colour the markers stay, otherwise an
 * `H2` would be indistinguishable from body text in a piped log.
 */
function renderHeading(block, { colorize, width, hyperlinks }) {
  const text = renderInline(block.text, { colorize, hyperlinks });
  if (!colorize) return `${wrap(`${"#".repeat(block.level)} ${text}`, { width })}\n`;
  const level = Math.min(block.level, 6);
  const palette = ["accentStrong", "accent", "cyan", "blue", "muted", "muted"];
  const tinted = color(palette[level - 1], wrap(text, { width }));
  return `${level <= 3 ? bold(tinted) : tinted}\n`;
}

/**
 * Code blocks are framed by a dim left rule instead of a background fill: the
 * old `bgColor("black")` + `padEnd` painted a black rectangle across the whole
 * terminal width, which is unreadable on light themes (P3a-3). Syntax
 * highlighting is deliberately out of scope; only the language label is kept.
 */
function renderCodeBlock(block, { colorize }) {
  const langLabel = block.lang ? `(${block.lang})` : "(code)";
  const streaming = block.closed ? "" : " (streaming)";
  const open = colorize
    ? dim(`┌─ code ${langLabel}${streaming}`)
    : `--- code ${langLabel}${streaming}`;
  const close = colorize ? dim("└──") : "---";
  const gutter = colorize ? dim("│") : " ";
  // Code fences are the Trojan Source hot spot — a bidi override inside a
  // fenced block is what makes reviewed code differ from executed code — and
  // the one place a reader most expects to see the bytes as they are.
  const body = block.lines.map((line) => `${gutter} ${sanitizeTerminalText(line ?? "")}`.trimEnd());
  return `${open}\n${body.join("\n")}${body.length ? "\n" : ""}${close}\n`;
}

function renderRule({ colorize, width }) {
  const line = "─".repeat(Math.max(1, Math.min(Number.isFinite(width) ? width : 80, 120)));
  return `${colorize ? dim(line) : line}\n`;
}

/**
 * Block quotes render through the full pipeline (so nested lists / code keep
 * working) and are then prefixed with a dim vertical rule.
 */
function renderQuote(block, { colorize, width, hyperlinks }) {
  const inner = renderMarkdown(block.lines.join("\n"), {
    width: Math.max(8, (Number.isFinite(width) ? width : 80) - 2),
    color: colorize,
    hyperlinks
  });
  const bar = colorize ? dim("│") : ">";
  const lines = inner.replace(/\n$/, "").split("\n");
  const body = lines.map((line) => `${bar} ${line}`.trimEnd()).join("\n");
  return `${colorize ? dim(body) : body}\n`;
}

function renderList(block, { colorize, width, hyperlinks }) {
  const lines = block.items.map((item) => {
    const indent = " ".repeat(Math.max(0, item.indent));
    const symbol = listSymbol(item);
    const inline = renderInline(item.text, { colorize, hyperlinks });
    const bullet = colorize ? color(item.task === true ? "success" : "cyan", symbol) : symbol;
    return wrap(`${indent}${bullet} ${inline}`, {
      width,
      indent: indent.length + visibleWidth(symbol) + 1
    });
  });
  return `${lines.join("\n")}\n`;
}

function listSymbol(item) {
  if (item.task === true) return "[✓]";
  if (item.task === false) return "[ ]";
  return item.marker.match(/\d+\./) ? item.marker : "•";
}

function renderTable(block, { colorize, width, hyperlinks }) {
  const rows = block.lines.map((line) => splitTableRow(line));
  if (rows.length < 2) return "";
  const header = rows[0];
  const body = rows.slice(2);
  const columnCount = header.length;
  // Measure the *rendered* cell (P3a-4). Measuring the raw Markdown counted
  // `**bold**` as 8 columns wider than it draws and left ragged padding.
  const renderedRows = [header, ...body].map((row) =>
    row.slice(0, columnCount).map((cell) => renderInline(cell, { colorize, hyperlinks }))
  );
  const widths = new Array(columnCount).fill(0);
  for (const row of renderedRows) {
    row.forEach((cell, idx) => {
      const w = visibleWidth(cell);
      if (idx < columnCount && w > widths[idx]) widths[idx] = w;
    });
  }
  shrinkToFit(widths, width);
  const formatRow = (row, isHeader) => {
    const cells = row.slice(0, columnCount).map((cell, idx) => {
      const clipped = visibleWidth(cell) > widths[idx] ? truncateToWidth(cell, widths[idx]) : cell;
      const padded = padEnd(clipped, widths[idx]);
      return isHeader && colorize ? bold(padded) : padded;
    });
    while (cells.length < columnCount) cells.push(" ".repeat(widths[cells.length]));
    return `│ ${cells.join(" │ ")} │`;
  };
  const ruler = `├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
  const top = `┌${widths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
  const bottom = `└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;
  const lines = [
    top,
    formatRow(renderedRows[0], true),
    ruler,
    ...renderedRows.slice(1).map((row) => formatRow(row, false)),
    bottom
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Shrink the widest columns until the table fits `width`. Borders cost
 * `3 * columns + 1` columns, so a 40-column terminal still gets a readable
 * (truncated) table instead of a wrapped mess.
 */
function shrinkToFit(widths, width) {
  if (!Number.isFinite(width) || width <= 0) return widths;
  const chrome = widths.length * 3 + 1;
  const minCell = 3;
  let budget = width - chrome;
  if (budget < widths.length * minCell) budget = widths.length * minCell;
  let total = widths.reduce((sum, w) => sum + w, 0);
  while (total > budget) {
    let widest = 0;
    for (let idx = 1; idx < widths.length; idx += 1) {
      if (widths[idx] > widths[widest]) widest = idx;
    }
    if (widths[widest] <= minCell) break;
    widths[widest] -= 1;
    total -= 1;
  }
  return widths;
}

function splitTableRow(line) {
  const trimmed = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderParagraph(block, { colorize, width, hyperlinks }) {
  const inline = renderInline(block.text.replace(/\n/g, " "), { colorize, hyperlinks });
  return `${wrap(inline, { width })}\n`;
}

/* ------------------------------------------------------------------ *
 * Width-aware wrapping (P3a-1)
 * ------------------------------------------------------------------ */

/**
 * Zero-width escape handling for the wrapper. `ANSI_SOURCE` covers CSI SGR
 * *and* OSC 8 (both `ESC \` and BEL terminated), so a hyperlink is one
 * indivisible atom: the tokenizer can never cut `ESC]8;;https://…ESC\` in
 * half, and the wrapper never counts a URI as visible columns.
 */
const ANSI_SEQUENCE = new RegExp(`^(?:${ANSI_SOURCE})$`);
const ANSI_SPLIT = new RegExp(`(${ANSI_SOURCE})`);
const ANSI_GLOBAL = new RegExp(ANSI_SOURCE, "g");
const OSC8_OPEN_OR_CLOSE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Must not be the first character of a line (行頭禁則). */
const NO_LINE_START = new Set([
  ..."、。，．・：；？！゛゜ゝゞヽヾ々ー〜–—",
  ..."）〕］｝〉》」』】｣、。",
  ..."ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ",
  ..."）)]}>,.:;!?%‰°”’»"
]);

/** Must not be the last character of a line (行末禁則). */
const NO_LINE_END = new Set([...
  "（〔［｛〈《「『【｢([{<“‘«￥＄$£"
]);

/**
 * Split `text` into wrap atoms. Latin runs stay glued into words so English
 * still breaks on spaces, while every wide (CJK / emoji) cluster becomes its
 * own atom so Japanese breaks per character. ANSI escapes carry no width and
 * are attached to the neighbouring atom, so a sequence is never cut in half
 * and never counted as visible columns.
 */
function tokenizeForWrap(text) {
  const tokens = [];
  let word = "";
  let wordWidth = 0;
  let pending = "";

  const pushWord = () => {
    if (!word) return;
    tokens.push({ text: word, width: wordWidth, kind: "word" });
    word = "";
    wordWidth = 0;
  };
  const startWord = () => {
    if (!word) {
      word = pending;
      pending = "";
    }
  };
  const pushAtom = (value, atomWidth, kind) => {
    pushWord();
    tokens.push({ text: `${pending}${value}`, width: atomWidth, kind });
    pending = "";
  };
  const attachAnsi = (sequence) => {
    // Closing sequences follow their word, opening ones follow a space. Keeping
    // an escape that sits after whitespace with the *next* atom means a colour
    // span opens on the same line as the text it colours.
    if (word) word += sequence;
    else if (tokens.length > 0 && tokens[tokens.length - 1].kind !== "space") {
      tokens[tokens.length - 1].text += sequence;
    } else pending += sequence;
  };

  for (const part of String(text ?? "").split(ANSI_SPLIT)) {
    if (part === "") continue;
    if (ANSI_SEQUENCE.test(part) && part.startsWith("\x1b")) {
      attachAnsi(part);
      continue;
    }
    for (const cluster of graphemes(part)) {
      if (cluster === "\n") {
        pushAtom("", 0, "break");
        continue;
      }
      if (/^\s$/.test(cluster)) {
        const last = tokens[tokens.length - 1];
        if (!word && last && last.kind === "space") {
          last.text += cluster;
          last.width += 1;
          continue;
        }
        pushAtom(cluster === "\t" ? "    " : cluster, cluster === "\t" ? 4 : 1, "space");
        continue;
      }
      const clusterWidth = visibleWidth(cluster);
      if (clusterWidth >= 2) {
        pushAtom(cluster, clusterWidth, "cjk");
        continue;
      }
      startWord();
      word += cluster;
      wordWidth += clusterWidth;
    }
  }
  pushWord();
  if (pending) {
    if (tokens.length > 0) tokens[tokens.length - 1].text += pending;
    else tokens.push({ text: pending, width: 0, kind: "word" });
  }
  return tokens;
}

function firstVisibleCluster(token) {
  const plain = stripAnsi(token.text);
  return plain ? graphemes(plain)[0] : "";
}

function lastVisibleCluster(token) {
  const plain = stripAnsi(token.text);
  if (!plain) return "";
  const clusters = graphemes(plain);
  return clusters[clusters.length - 1];
}

function ansiOnly(value) {
  return (value.match(ANSI_GLOBAL) ?? []).join("");
}

/**
 * Close every hyperlink at the end of the line it started on and re-open it
 * on the next one.
 *
 * A link region is a *terminal state*, not a character range: once
 * `ESC]8;;URI ST` is written every cell painted afterwards belongs to the
 * link until the closing sequence arrives. If a wrapped link spanned rows we
 * would therefore hand the terminal a link that also covers the trailing
 * padding, the hanging indent of the continuation row — and, inside a block
 * quote, the `│ ` prefix that `renderQuote` glues on afterwards, since that
 * prefix is inserted *after* wrapping. Re-opening per row keeps every
 * clickable region exactly as wide as its text.
 *
 * The re-open is placed after the row's leading whitespace so the indent
 * itself never becomes clickable.
 */
function reopenHyperlinksPerLine(lines) {
  let open = "";
  return lines.map((line) => {
    let out = line;
    if (open) {
      const lead = /^[ \t]*/.exec(out)[0];
      out = `${lead}${open}${out.slice(lead.length)}`;
    }
    for (const match of out.matchAll(OSC8_OPEN_OR_CLOSE)) {
      open = match[1] ? match[0] : "";
    }
    return open ? `${out}${HYPERLINK_CLOSE}` : out;
  });
}

/**
 * Wrap `text` to `width` visible columns. `indent` is the hanging indent used
 * for continuation lines (list items pass the bullet width so the text stays
 * aligned).
 */
function wrap(text, { width = 80, indent = 0 } = {}) {
  if (!Number.isFinite(width) || width <= 0) return text;
  const value = String(text ?? "");
  const padWidth = Math.max(0, Math.min(indent, Math.max(0, width - 1)));
  const pad = " ".repeat(padWidth);
  const tokens = tokenizeForWrap(value);
  const lines = [];
  let line = [];
  let lineWidth = 0;

  const hasVisible = (entries) => entries.some((entry) => entry.width > 0 && entry.kind !== "pad");
  const flush = () => {
    while (line.length > 0 && line[line.length - 1].kind === "space") {
      const trailing = line.pop();
      const keep = ansiOnly(trailing.text);
      if (keep) {
        if (line.length > 0) line[line.length - 1].text += keep;
        else line.push({ text: keep, width: 0, kind: "pad" });
      }
    }
    lines.push(line.map((entry) => entry.text).join(""));
    line = padWidth > 0 ? [{ text: pad, width: padWidth, kind: "pad" }] : [];
    lineWidth = padWidth;
  };

  for (const token of tokens) {
    if (token.kind === "break") {
      flush();
      continue;
    }
    if (token.kind === "space") {
      if (!hasVisible(line)) {
        // Swallow the leading break but keep any colour changes it carried.
        const keep = ansiOnly(token.text);
        if (keep && line.length > 0) line[line.length - 1].text += keep;
        else if (keep) line.push({ text: keep, width: 0, kind: "pad" });
        continue;
      }
      line.push(token);
      lineWidth += token.width;
      continue;
    }
    let current = token;
    for (;;) {
      if (lineWidth + current.width <= width) {
        line.push(current);
        lineWidth += current.width;
        break;
      }
      if (hasVisible(line)) {
        const carry = applyKinsoku(line, current, width - padWidth);
        flush();
        for (const entry of carry) {
          line.push(entry);
          lineWidth += entry.width;
        }
        continue;
      }
      // Unbreakable atom wider than a whole line — split it by graphemes so a
      // long URL or a run of CJK cannot overflow the terminal.
      const budget = Math.max(1, width - lineWidth);
      const [head, rest] = splitToken(current, budget);
      if (head.width === 0) {
        line.push(current);
        lineWidth += current.width;
        break;
      }
      line.push(head);
      lineWidth += head.width;
      flush();
      current = rest;
    }
  }
  if (hasVisible(line)) flush();
  else if (line.length > 0 && lines.length === 0) flush();
  if (lines.length > 1 && value.includes("\x1b]8;")) {
    return reopenHyperlinksPerLine(lines).join("\n");
  }
  return lines.join("\n");
}

/**
 * Move trailing atoms down to the next line so a line never ends with an
 * opening bracket and never starts with closing punctuation (簡易禁則処理).
 * Returns the atoms carried to the next line.
 */
function applyKinsoku(line, nextToken, lineBudget) {
  const carry = [];
  const carryWidth = () => carry.reduce((sum, entry) => sum + entry.width, 0);
  const lastVisibleIndex = () => {
    for (let idx = line.length - 1; idx >= 0; idx -= 1) {
      if (line[idx].kind !== "pad" && line[idx].width > 0) return idx;
    }
    return -1;
  };
  const canPull = (idx) => {
    if (idx <= 0) return false;
    if (!line.slice(0, idx).some((entry) => entry.kind !== "pad" && entry.width > 0)) return false;
    const moved = line.slice(idx).reduce((sum, entry) => sum + entry.width, 0);
    return carryWidth() + moved + nextToken.width <= lineBudget;
  };

  if (NO_LINE_START.has(firstVisibleCluster(nextToken))) {
    const idx = lastVisibleIndex();
    if (canPull(idx)) carry.unshift(...line.splice(idx));
  }
  for (let guard = 0; guard < 4; guard += 1) {
    const idx = lastVisibleIndex();
    if (idx < 0) break;
    if (!NO_LINE_END.has(lastVisibleCluster(line[idx]))) break;
    if (!canPull(idx)) break;
    carry.unshift(...line.splice(idx));
  }
  while (carry.length > 0 && carry[carry.length - 1].kind === "space") carry.pop();
  return carry;
}

/** Split one atom at `budget` visible columns without cutting a cluster. */
function splitToken(token, budget) {
  let head = "";
  let headWidth = 0;
  let rest = "";
  let done = false;
  for (const part of token.text.split(ANSI_SPLIT)) {
    if (part === "") continue;
    if (ANSI_SEQUENCE.test(part) && part.startsWith("\x1b")) {
      if (done) rest += part;
      else head += part;
      continue;
    }
    for (const cluster of graphemes(part)) {
      const clusterWidth = visibleWidth(cluster);
      if (!done && headWidth + clusterWidth <= budget) {
        head += cluster;
        headWidth += clusterWidth;
      } else {
        done = true;
        rest += cluster;
      }
    }
  }
  return [
    { text: head, width: headWidth, kind: token.kind },
    { text: rest, width: token.width - headWidth, kind: token.kind }
  ];
}

function renderInline(text, { colorize, hyperlinks = false }) {
  if (typeof text !== "string") return "";
  // Normally a no-op (`renderMarkdown` / `splitReadyBlocks` already sanitised
  // the source), but `renderMarkdownBlocks` is exported and can be handed a
  // block list built elsewhere. Sanitising is idempotent, so the belt costs
  // nothing and the braces cover that route.
  let out = sanitizeTerminalText(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    if (!colorize) return `\`${code}\``;
    // No background fill: the old grey-on-brightYellow pill was unreadable on
    // light terminals (P3a-3). A single accent colour is theme-neutral.
    return color("accent", code);
  });
  out = out.replace(/\*\*([^*\x1b]+)\*\*/g, (_, body) => (colorize ? bold(body) : `**${body}**`));
  out = out.replace(/(?<!\*)\*([^*\x1b]+)\*(?!\*)/g, (_, body) => (colorize ? italic(body) : `*${body}*`));
  // Strikethrough runs AFTER bold/italic so both nestings work: `**~~a~~**`
  // (bold matched the raw `~~a~~`) and `~~**a**~~` (the body now holds an
  // `ESC[1m` run). Unlike the classes above, `\x1b` is NOT excluded here —
  // and it does not need to be, because `~` cannot occur inside an SGR
  // sequence, and links (whose URIs can contain `~`) are expanded below.
  out = out.replace(/~~([^~\n]+)~~/g, (_, body) => (colorize ? dim(strikethrough(body)) : `~~${body}~~`));
  // `\x1b` is excluded from the classes below on purpose: an earlier pass has
  // already injected escape sequences such as `ESC[1m`, and a naive `\[...\]`
  // would happily start matching inside one of them and swallow the rest of
  // the line (that bug ate `**bold**` whenever a link followed it).
  out = out.replace(/\[([^[\]\x1b]+)\]\(([^)\x1b]+)\)/g, (_, label, url) => {
    if (!colorize) return `${label} (${url})`;
    // The URL stays on screen even when the label becomes clickable. A
    // hyperlink whose visible text and destination disagree is a phishing
    // primitive, and this text comes from a *model*: keeping `label (url)`
    // means the user can always read where a click will actually go. The OSC
    // 8 region covers both parts, so clicking either one works.
    const shown = `${underline(color("cyan", label))} ${dim(`(${url})`)}`;
    if (!hyperlinks || !isSafeHyperlinkUri(url)) return shown;
    return hyperlink(url, shown);
  });
  return out;
}
