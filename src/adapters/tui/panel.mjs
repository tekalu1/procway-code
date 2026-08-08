/**
 * The shared visual language for everything the REPL prints between turns
 * (P3b-1).
 *
 * Before Phase 3b the TUI spoke three dialects at once: `renderWelcome`'s
 * rounded box, `renderStatus`'s two-space label/value pairs, and a raw
 * `JSON.stringify(result, null, 2)` for `/usage`, `/context`, `/plan`,
 * `/todos`, `/memory`, `/branch` and `/compact`. The decision here is:
 *
 *   - the welcome card stays the ONE box — it is the session's identity card,
 *     printed at start-up and after a session swap;
 *   - every other panel is a lightweight *section*: a `▌ Title` heading in the
 *     accent colour, then indented rows whose labels share one aligned column.
 *
 * That keeps the accent glyph + colour ramp of the box without paying for
 * border alignment on output whose width we do not control (a resolved skill
 * path, a shell command, a 12-column usage table).
 *
 * Every width computation goes through ansi.mjs (`visibleWidth` / `padEnd` /
 * `truncateToWidth`), so CJK and emoji cannot push a column out of alignment.
 */

import { padEnd, style, truncateToWidth, visibleWidth } from "./ansi.mjs";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.mjs";

export const INDENT = "  ";

/**
 * Collapse a value to ONE row. Session titles are the first user message, so
 * they routinely contain newlines — and one embedded `\n` inside a table cell
 * shifts every column after it and desyncs any in-place repaint that counted
 * the rows it drew (P3b-5).
 *
 * P3e-2: also the sanitisation point for every one-line cell in the TUI. Panel
 * values are the widest external-text funnel there is — provider error
 * messages, session titles, model ids, resolved paths, tool arguments in the
 * approval panel — and all of them arrive here or at `wrapText` below.
 */
export function singleLine(value) {
  return sanitizeInline(value);
}

/**
 * Colour `value`, or hand it back plain. Every caller passes UNSTYLED text
 * (the panels concatenate painted fragments, they never re-paint one), so this
 * doubles as the sanitisation point for the ad-hoc one-liners that do not go
 * through `renderPanel` — the approval question, `/model`, the welcome tip.
 *
 * Note the `!enabled` branch matters just as much: `color:false` is the piped
 * / `NO_COLOR` / `> file` route, and a log file that is dangerous to `cat` is
 * exactly as bad as a dangerous live terminal.
 */
export function paint(value, names, enabled) {
  const text = sanitizeTerminalText(value);
  return enabled ? style(names, text) : text;
}

/** `▌ Title  subtitle` — the one heading form used by every panel. */
export function renderHeading(title, { subtitle = null, color = true } = {}) {
  // Subtitles carry external strings (a pricing key, a memory directory, a
  // provider id), and a title can too (`The provider returned 502`).
  const head = `${paint("▌", "accent", color)} ${paint(sanitizeInline(title), ["accentStrong", "bold"], color)}`;
  return subtitle ? `${head}  ${paint(sanitizeInline(subtitle), "muted", color)}` : head;
}

/**
 * A titled block of `label  value` rows.
 *
 * `rows` accepts:
 *   - `[label, value]` / `{ label, value, tone }` → an aligned pair
 *   - `"free text"`                              → one indented line
 *   - `null` / `undefined`                       → a blank separator line
 *
 * @param {{ title?: string, subtitle?: string, rows?: Array<unknown>,
 *           notes?: string[], width?: number, color?: boolean }} params
 */
export function renderPanel({ title = null, subtitle = null, rows = [], notes = [], width = 80, color = true } = {}) {
  const lines = [];
  if (title) lines.push(renderHeading(title, { subtitle, color }));
  const pairs = rows.filter((row) => isPair(row)).map(toPair);
  const labelWidth = pairs.reduce((max, pair) => Math.max(max, visibleWidth(pair.label)), 0);
  const valueWidth = Math.max(8, width - INDENT.length - labelWidth - 2);
  for (const row of rows) {
    if (row == null) { lines.push(""); continue; }
    if (!isPair(row)) {
      lines.push(`${INDENT}${clamp(sanitizeInline(row), Math.max(8, width - INDENT.length), color)}`);
      continue;
    }
    const { label, value, tone } = toPair(row);
    // Wrapped, not truncated: a panel row carries the answer the user asked
    // for (a path, a provider error, a hint) and clipping it defeats the point.
    const wrapped = wrapText(String(value ?? ""), valueWidth);
    const gutter = `${INDENT}${" ".repeat(labelWidth)}  `;
    wrapped.forEach((text, index) => {
      const body = tone ? paint(text, tone, color) : text;
      lines.push(index === 0
        ? `${INDENT}${paint(padEnd(label, labelWidth), "muted", color)}  ${body}`
        : `${gutter}${body}`);
    });
  }
  for (const note of notes) {
    // Sanitise BEFORE the lead is measured: `\s` matches VT (0x0B) and FF
    // (0x0C), so an indent read off the raw string could copy a form feed —
    // which clears the screen on several terminals — into our own output.
    const raw = sanitizeTerminalText(note);
    // Notes may be deliberately indented (the "Try:" list under an error);
    // wrapText normalises whitespace, so keep the lead and re-apply it.
    const lead = /^\s*/.exec(raw)[0];
    // -2 for the hanging indent continuation rows carry.
    const noteWidth = Math.max(8, width - INDENT.length - lead.length - 2);
    const rows = wrapText(raw.trim(), noteWidth);
    rows.forEach((text, index) => {
      lines.push(`${INDENT}${lead}${index === 0 ? "" : "  "}${paint(text, "muted", color)}`);
    });
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A column-aligned table. Numeric columns are right-aligned so digits line up
 * — the single biggest readability win over the old JSON dump for `/usage`.
 *
 * @param {{ title?: string, subtitle?: string,
 *           columns: Array<{ key: string, label?: string, align?: "left"|"right" }>,
 *           rows: Array<object>, footer?: object|null,
 *           width?: number, color?: boolean, empty?: string }} params
 */
export function renderTable({
  title = null,
  subtitle = null,
  columns = [],
  rows = [],
  footer = null,
  width = 80,
  color = true,
  empty = "(none)"
} = {}) {
  const lines = [];
  if (title) lines.push(renderHeading(title, { subtitle, color }));
  if (rows.length === 0 && !footer) {
    lines.push(`${INDENT}${paint(empty, "muted", color)}`);
    return `${lines.join("\n")}\n`;
  }
  // One row in, one row out: a cell containing a newline would break every
  // column to its right.
  const cells = rows.map((row) => columns.map((column) => singleLine(row?.[column.key])));
  const footerCells = footer ? columns.map((column) => singleLine(footer?.[column.key])) : null;
  const widths = columns.map((column, index) => {
    const header = sanitizeInline(column.label ?? column.key);
    const body = cells.map((row) => visibleWidth(row[index]));
    if (footerCells) body.push(visibleWidth(footerCells[index]));
    return Math.max(visibleWidth(header), ...(body.length > 0 ? body : [0]));
  });
  const line = (values) => {
    const parts = values.map((value, index) => (
      columns[index].align === "right"
        ? padStartWidth(value, widths[index])
        : padEnd(value, widths[index])
    ));
    return `${INDENT}${clamp(parts.join("  ").replace(/\s+$/, ""), Math.max(8, width - INDENT.length), color)}`;
  };
  lines.push(paint(line(columns.map((column) => sanitizeInline(column.label ?? column.key))), "muted", color));
  for (const row of cells) lines.push(line(row));
  if (footerCells) {
    const ruleWidth = Math.min(
      Math.max(8, width - INDENT.length),
      widths.reduce((sum, value) => sum + value, 0) + (widths.length - 1) * 2
    );
    lines.push(`${INDENT}${paint("─".repeat(ruleWidth), "muted", color)}`);
    lines.push(line(footerCells));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A checklist. `items` are `{ status, text }`, where status is one of
 * `completed` / `in_progress` / anything else (pending).
 */
export const CHECK_GLYPHS = Object.freeze({
  completed: { glyph: "✔", tone: "success" },
  in_progress: { glyph: "▸", tone: "warning" },
  pending: { glyph: "○", tone: "muted" }
});

export function renderChecklist({ title = null, subtitle = null, items = [], width = 80, color = true, empty = "(no todos)" } = {}) {
  const lines = [];
  if (title) lines.push(renderHeading(title, { subtitle, color }));
  if (items.length === 0) {
    lines.push(`${INDENT}${paint(empty, "muted", color)}`);
    return `${lines.join("\n")}\n`;
  }
  for (const item of items) {
    const spec = CHECK_GLYPHS[item?.status] ?? CHECK_GLYPHS.pending;
    const text = clamp(singleLine(item?.text), Math.max(8, width - INDENT.length - 2), color);
    const body = item?.status === "completed" ? paint(text, "muted", color) : text;
    lines.push(`${INDENT}${paint(spec.glyph, spec.tone, color)} ${body}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Word-wrap plain text to `width` cells, measured in grapheme columns. Long
 * words that do not fit on their own are hard-split rather than overflowing.
 */
export function wrapText(text, width) {
  const limit = Math.max(4, Number(width) || 80);
  const out = [];
  // The other half of the P3e-2 funnel: panel row values, panel notes, the
  // reasoning stream and the `/help` listing all wrap through here, and all of
  // them are painted AFTER this call — so sanitising here is upstream of every
  // escape we emit ourselves.
  for (const paragraph of sanitizeTerminalText(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (visibleWidth(candidate) <= limit) { line = candidate; continue; }
      if (line !== "") out.push(line);
      let rest = word;
      while (visibleWidth(rest) > limit) {
        out.push(truncateToWidth(rest, limit, ""));
        rest = rest.slice(truncateToWidth(rest, limit, "").length);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

/** Right-align to `width` cells (the `padEnd` mirror image). */
export function padStartWidth(text, width) {
  const value = String(text ?? "");
  const pad = Math.max(0, width - visibleWidth(value));
  return `${" ".repeat(pad)}${value}`;
}

function clamp(text, width, color) {
  void color;
  return truncateToWidth(text, Math.max(1, width));
}

function isPair(row) {
  return Array.isArray(row) || (row != null && typeof row === "object");
}

function toPair(row) {
  // Labels are usually literals, but `/status` builds one per disabled tool
  // and the tool name is model-visible. The value side is sanitised by
  // `wrapText`; the label side has to be done here, before `padEnd` measures it.
  if (Array.isArray(row)) return { label: sanitizeInline(row[0]), value: row[1], tone: row[2] ?? null };
  return { label: sanitizeInline(row.label), value: row.value, tone: row.tone ?? null };
}
