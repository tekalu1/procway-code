import { transcriptFromMessages } from "../../tui/transcript.mjs";
import {
  bold,
  color,
  dim,
  italic,
  underline,
  bgColor,
  visibleWidth,
  padEnd
} from "./ansi.mjs";

/**
 * String-render the transcript projection for terminal output. Backward
 * compatible with the Phase 3/4 callers — `renderTranscript` still accepts a
 * raw legacy message array and returns a labelled "You / Assistant / Tool"
 * block.
 *
 * The Phase 5 expansion lives in `renderMarkdown`: it parses the Markdown
 * subset described in §2.3 of the brief (headings / lists / inline code /
 * fenced code / strong / italic / links / tables) and produces an ANSI-
 * coloured string. Adapters MUST treat the renderer as a pure function and
 * leave actual `process.stdout.write` to a single sink in cli.mjs / the
 * streaming renderer (Phase 5 brief §4 — avoid hotfix 294f143 recurrence).
 */
export function renderTranscript(messages = [], { maxMessages, maxChars, markdown = false, width = 80 } = {}) {
  const nodes = transcriptFromMessages(messages, { maxMessages });
  if (nodes.length === 0) return "(no prior conversation)\n";
  return nodes
    .map((node) => {
      const label = labelForRole(node.role);
      const body = truncate(node.text, maxChars);
      // Phase 7 hotfix: when resuming a session interactively, render the
      // assistant's Markdown so the recap matches the live-conversation look
      // (ANSI headings / lists / code blocks / tables). Plain text is kept
      // for `you` and `tool` lines and for non-interactive callers.
      if (markdown && node.role === "assistant") {
        const rendered = renderMarkdown(body, { width, color: true });
        return `${label}:\n${rendered}`;
      }
      return `${label}: ${body}`;
    })
    .join("\n\n") + "\n";
}

export function printTranscript({ messages, output = process.stdout, maxMessages, maxChars, markdown = false, width }) {
  output.write(renderTranscript(messages, {
    maxMessages,
    maxChars,
    markdown,
    width: width ?? output?.columns ?? 80
  }));
}

/**
 * Render Markdown to an ANSI-coloured string for terminal display.
 *
 * @param {string} text  Markdown source (full document or pre-flushed slice).
 * @param {{ width?: number, color?: boolean }} [options]
 * @returns {string}
 */
export function renderMarkdown(text, { width = 80, color: colorize = true } = {}) {
  if (typeof text !== "string") return "";
  const blocks = parseBlocks(text);
  const out = [];
  for (const block of blocks) {
    out.push(renderBlock(block, { width, colorize }));
  }
  return out.join("");
}

export const __test = { parseBlocks, renderInline };

function labelForRole(role) {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool";
  return role;
}

function truncate(value, maxChars) {
  if (maxChars == null) return value;
  if (typeof value !== "string") return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

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
      index = closed ? cursor + 1 : cursor;
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      blocks.push({ kind: "heading", level: headingMatch[1].length, text: headingMatch[2] });
      index += 1;
      continue;
    }
    if (/^\s*$/.test(line)) {
      blocks.push({ kind: "blank" });
      index += 1;
      continue;
    }
    if (looksLikeTable(lines, index)) {
      const tableLines = [];
      while (index < lines.length && /\|/.test(lines[index]) && !/^\s*$/.test(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "table", lines: tableLines });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length) {
        const itemMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[index]);
        if (!itemMatch) break;
        items.push({
          indent: itemMatch[1].length,
          marker: itemMatch[2],
          text: itemMatch[3]
        });
        index += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const paragraphLines = [];
    while (index < lines.length && !/^\s*$/.test(lines[index]) && !/^```/.test(lines[index]) && !/^(#{1,6})\s+/.test(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
  }
  return blocks;
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
  return renderParagraph(block, ctx);
}

function renderHeading(block, { colorize }) {
  const palette = ["cyan", "blue", "magenta", "yellow", "white", "white"];
  const prefix = "#".repeat(block.level);
  const text = renderInline(block.text, { colorize });
  if (!colorize) return `${prefix} ${text}\n`;
  const tinted = color(palette[Math.min(block.level - 1, palette.length - 1)], `${prefix} ${text}`);
  return `${bold(tinted)}\n`;
}

function renderCodeBlock(block, { colorize, width }) {
  const langLabel = block.lang ? `(${block.lang})` : "(code)";
  const open = colorize ? dim(`┌─ code ${langLabel} ${block.closed ? "" : "(streaming)"}`.trimEnd()) : `--- code ${langLabel}${block.closed ? "" : " (streaming)"}`;
  const close = colorize ? dim("└──") : "---";
  const body = block.lines.map((line) => {
    const visible = line ?? "";
    if (!colorize) return `  ${visible}`;
    return `  ${bgColor("black", color("brightYellow", padEnd(visible, Math.max(0, width - 4))))}`;
  });
  return `${open}\n${body.join("\n")}${body.length ? "\n" : ""}${close}\n`;
}

function renderList(block, { colorize, width }) {
  const lines = block.items.map((item) => {
    const indent = " ".repeat(Math.max(0, item.indent));
    const symbol = item.marker.match(/\d+\./) ? item.marker : "•";
    const inline = renderInline(item.text, { colorize });
    const bullet = colorize ? color("cyan", symbol) : symbol;
    return wrap(`${indent}${bullet} ${inline}`, { width, indent: indent.length + symbol.length + 1 });
  });
  return `${lines.join("\n")}\n`;
}

function renderTable(block, { colorize }) {
  const rows = block.lines.map((line) => splitTableRow(line));
  if (rows.length < 2) return "";
  const header = rows[0];
  const body = rows.slice(2);
  const columnCount = header.length;
  const widths = new Array(columnCount).fill(0);
  for (const row of [header, ...body]) {
    row.forEach((cell, idx) => {
      const w = visibleWidth(cell);
      if (idx < columnCount && w > widths[idx]) widths[idx] = w;
    });
  }
  const formatRow = (row, isHeader) => {
    const cells = row.slice(0, columnCount).map((cell, idx) => {
      const rendered = renderInline(cell, { colorize });
      const padded = padEnd(rendered, widths[idx]);
      return isHeader && colorize ? bold(padded) : padded;
    });
    while (cells.length < columnCount) cells.push(" ".repeat(widths[cells.length]));
    return `│ ${cells.join(" │ ")} │`;
  };
  const ruler = `├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
  const top = `┌${widths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
  const bottom = `└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;
  const lines = [top, formatRow(header, true), ruler, ...body.map((row) => formatRow(row, false)), bottom];
  return `${lines.join("\n")}\n`;
}

function splitTableRow(line) {
  const trimmed = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderParagraph(block, { colorize, width }) {
  const inline = renderInline(block.text.replace(/\n/g, " "), { colorize });
  return `${wrap(inline, { width })}\n`;
}

function wrap(text, { width = 80, indent = 0 } = {}) {
  if (!Number.isFinite(width) || width <= 0) return text;
  const lines = [];
  let current = "";
  let currentWidth = 0;
  const tokens = text.split(/(\s+)/);
  for (const token of tokens) {
    const tokenWidth = visibleWidth(token);
    if (currentWidth + tokenWidth > width && current.trimEnd().length > 0) {
      lines.push(current.trimEnd());
      current = " ".repeat(indent);
      currentWidth = indent;
      if (/^\s+$/.test(token)) continue;
    }
    current += token;
    currentWidth += tokenWidth;
  }
  if (current.trimEnd().length > 0) lines.push(current.trimEnd());
  return lines.join("\n");
}

function renderInline(text, { colorize }) {
  if (typeof text !== "string") return "";
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    if (!colorize) return `\`${code}\``;
    return bgColor("gray", color("brightYellow", ` ${code} `));
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, body) => (colorize ? bold(body) : `**${body}**`));
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, body) => (colorize ? italic(body) : `*${body}*`));
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    if (!colorize) return `${label} (${url})`;
    return `${underline(color("cyan", label))} ${dim(`(${url})`)}`;
  });
  return out;
}
