import path from "node:path";
import { ESC, padEnd, style, truncateToWidth, visibleWidth } from "./ansi.mjs";
import { renderPanel } from "./panel.mjs";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.mjs";
import { formatTokens, formatUsd } from "./format.mjs";

/**
 * Rich shell chrome (welcome card, prompt, status). Every width computation
 * goes through ansi.mjs `visibleWidth`/`padEnd`/`truncateToWidth` so a CJK or
 * emoji-bearing cwd cannot push the box borders out of alignment, and every
 * colour comes from the shared ansi.mjs palette (no private 256-colour table).
 *
 * P3b-1 (visual language): the welcome card is the ONE box — it is the
 * session's identity card. `renderStatus` used to invent a third dialect
 * (label + two spaces + value, no title, no colour ramp); it now shares the
 * `▌ Title` + aligned-rows panel that every other slash command prints, so
 * `/status`, `/usage`, `/context`, `/memory`, `/plan` and `/compact` all look
 * like the same program.
 */

// `sanitizeTerminalText`, NOT `sanitizeInline`: this paints the box borders and
// the `label.padEnd(10)` gutters, whose leading/trailing spaces ARE the layout.
// Callers that hand it external text collapse it to one line themselves.
function paint(value, names, enabled) {
  const text = sanitizeTerminalText(value);
  return enabled ? style(names, text) : text;
}

function row(label, value, innerWidth, color) {
  const prefix = ` ${label.padEnd(10)} `;
  const contentWidth = Math.max(1, innerWidth - visibleWidth(prefix));
  // The workspace path, the session id and the model id all land in this box.
  // A newline in any of them would also break the border alignment, so the
  // one-line form is what we want anyway.
  const content = truncateToWidth(sanitizeInline(value), contentWidth);
  const padded = padEnd(content, contentWidth);
  return `${paint("│", "accent", color)}${paint(prefix, "muted", color)}${padded}${paint("│", "accent", color)}`;
}

export function renderWelcome({ sessionId, cwd, provider, model, approvalMode, width = 80, color = true } = {}) {
  // P4b-1: the 48-column floor used to win over a narrower terminal, so a
  // 30-column window got a 48-column box and every one of its six lines
  // wrapped. The card may never be wider than the terminal; 8 is simply the
  // narrowest box whose borders still leave a cell of content.
  const usable = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
  const boxWidth = Math.max(8, Math.min(usable, 92));
  const innerWidth = boxWidth - 2;
  // `╭` + title + fill + `╮` must total boxWidth: the two corner glyphs plus
  // the single `─` that follows `╭` are three cells, not two (P0-3). Below
  // ~17 columns even the title has to give.
  const title = truncateToWidth(" procway-code ", Math.max(1, boxWidth - 3), "…");
  const topFill = Math.max(0, boxWidth - visibleWidth(title) - 3);
  const top = `${paint("╭─", "accent", color)}${paint(title, ["accentStrong", "bold"], color)}${paint(`${"─".repeat(topFill)}╮`, "accent", color)}`;
  const bottom = paint(`╰${"─".repeat(innerWidth)}╯`, "accent", color);
  return [
    top,
    row("workspace", cwd, innerWidth, color),
    row("model", `${provider ?? "unconfigured"}:${model ?? "unconfigured"}`, innerWidth, color),
    row("approval", approvalMode ?? "default", innerWidth, color),
    row("session", sessionId, innerWidth, color),
    bottom,
    ...renderTips(usable, color),
    ""
  ].join("\n");
}

/**
 * The tip line(s) under the welcome card (P4b-1).
 *
 * It used to be one fixed 76-column string, which overflowed every terminal
 * narrower than that — and a wrapped tip is worse than a short one, because
 * the wrap lands mid-word. Two rules keep it inside the window:
 *
 *  1. pack greedily into at most {@link TIP_MAX_LINES} lines, continuation
 *     lines indented to sit under the first tip;
 *  2. when even that does not fit, drop whole tips (never half a tip) in
 *     `keep` order — the survivors are still rendered in reading order, so
 *     the line never reshuffles itself as the window is resized.
 *
 * `/help` and `Ctrl+C` are the last to go: one is how you find everything
 * else, the other is how you get out.
 */
const TIP_INDENT = 4;
const TIP_GAP = 2;
const TIP_MAX_LINES = 2;
const TIPS = [
  // Ctrl+J is advertised here because "how do I type a newline?" was the
  // single most common question about the old one-line prompt (P2-2).
  { key: "/help", tail: " commands", keep: 4 },
  { key: "/config setup", tail: " provider", keep: 1 },
  { key: "Ctrl+J", tail: " newline", keep: 2 },
  { key: "Ctrl+C", tail: " interrupt", keep: 3 }
];

/** Greedy line packing, or `null` when `items` cannot fit the budget. */
function packTips(items, width) {
  const budget = width - TIP_INDENT;
  if (budget < 1) return null;
  const lines = [[]];
  let used = 0;
  for (const item of items) {
    const itemWidth = visibleWidth(`${item.key}${item.tail}`);
    if (itemWidth > budget) return null; // fits on no line at all
    const current = lines[lines.length - 1];
    const need = current.length === 0 ? itemWidth : used + TIP_GAP + itemWidth;
    if (need <= budget) {
      current.push(item);
      used = need;
    } else {
      if (lines.length >= TIP_MAX_LINES) return null;
      lines.push([item]);
      used = itemWidth;
    }
  }
  return lines;
}

function renderTips(width, color) {
  let items = TIPS;
  let packed = packTips(items, width);
  while (!packed && items.length > 1) {
    const weakest = items.reduce((low, item) => (item.keep < low.keep ? item : low));
    items = items.filter((item) => item !== weakest);
    packed = packTips(items, width);
  }
  if (!packed) {
    // Narrower than the shortest tip on its own: one clipped line still beats
    // a wrapped one, which would desync nothing but read as garbage.
    return [paint(truncateToWidth(`Tip ${TIPS[0].key}${TIPS[0].tail}`, Math.max(1, width)), "muted", color)];
  }
  return packed.map((line, index) => {
    const head = index === 0 ? paint("Tip", ["success", "bold"], color) : "   ";
    const body = line.map((item) => `${paint(item.key, "accentStrong", color)}${item.tail}`).join(" ".repeat(TIP_GAP));
    return `${head} ${body}`;
  });
}

/**
 * `N tools unavailable here: … — /status for why` (P4b-1).
 *
 * Lives here rather than in cli.mjs so it can be width-tested like every other
 * renderer. The list of names is unbounded, so instead of clipping mid-name
 * the note steps down through progressively shorter forms and lets `/status`
 * carry the detail — which is what the trailing pointer was always for.
 */
export function renderDisabledToolNote(entries, { width = 80, color = true } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (list.length === 0) return "";
  const limit = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
  const count = `${list.length} tool${list.length === 1 ? "" : "s"} unavailable`;
  const names = list.map((entry) => sanitizeInline(String(entry?.name ?? "tool"))).join(", ");
  const forms = [
    `${count} here: ${names} — /status for why`,
    `${count} — /status for why`,
    `${count} — /status`,
    count
  ];
  const text = forms.find((form) => visibleWidth(form) <= limit)
    ?? truncateToWidth(forms[forms.length - 1], limit);
  return `${paint(text, "muted", color)}\n\n`;
}

/**
 * The prompt header (P3b-9).
 *
 * What is on it, and why — the constraint is that anything permanently on
 * screen costs attention, so only state that changes what the NEXT keystroke
 * does earns a slot:
 *
 *   workspace         where writes land
 *   provider:model    which model is about to be billed
 *   approval mode     whether the agent will ask before writing/running —
 *                     previously invisible until you typed /status, which is
 *                     the one thing you cannot afford to be wrong about
 *   plan              only when on (it changes when writes happen)
 *   tokens / cost     only once the session has spent something
 *
 * Everything else (session id, absolute cwd, queued plan writes, resolved
 * skills) stays in `/status`.
 */
export function renderPrompt({
  cwd,
  provider,
  model,
  planMode = false,
  approvalMode = null,
  usage = null,
  width = null,
  color = true,
  tty = true
} = {}) {
  if (!tty) return "> ";
  // The prompt header is ONE row of the input region: a row that grows extra
  // lines desyncs the editor's repaint bookkeeping, which is why every segment
  // is collapsed to a single line as well as sanitised.
  const workspace = sanitizeInline(path.basename(cwd || process.cwd()));
  const spend = formatSpend(usage);
  // Ordered least-droppable first: the header is ONE row of the input region,
  // and a row that wraps desyncs the editor's repaint bookkeeping — so on a
  // narrow terminal segments are dropped from the right instead.
  const segments = [
    { text: workspace, style: "bold" },
    { text: sanitizeInline(`${provider ?? "?"}:${model ?? "?"}`), style: "muted" },
    ...(approvalMode ? [{ text: sanitizeInline(approvalMode), style: "muted" }] : []),
    ...(planMode ? [{ text: "plan", style: ["warning", "bold"] }] : []),
    ...(spend ? [{ text: spend, style: "muted" }] : [])
  ];
  // P4b-2: `Math.max(12, …)` used to raise the limit ABOVE the terminal width
  // on anything under 13 columns, and the `Math.max(3, …)` clip floor let the
  // last segment stay wider than the room left for it. Both are gone: the only
  // floor left is 1 (`Math.max(1, …)`), which is a width, not a minimum.
  const limit = Number.isFinite(width) && width > 0 ? Math.max(1, Math.floor(width) - 1) : Infinity;
  const prefix = "╭─ ";
  const prefixWidth = visibleWidth(prefix);
  const plainWidth = (parts) => prefixWidth + visibleWidth(parts.map((part) => part.text).join(" · "));
  let kept = segments;
  while (kept.length > 1 && plainWidth(kept) > limit) {
    kept = kept.slice(0, -1);
  }
  if (plainWidth(kept) > limit) {
    // Even the last surviving segment is too long (a very long model id on a
    // very narrow terminal): clip it rather than wrap the row. Below four
    // columns not even one clipped cell fits, so the header is bare.
    const room = limit - prefixWidth;
    kept = room >= 1 ? [{ ...kept[0], text: truncateToWidth(kept[0].text, room) }] : [];
  }
  const rendered = kept.map((part) => paint(part.text, part.style, color)).join(paint(" · ", "muted", color));
  // `╭─ ` with nothing after it would leave a trailing space that counts.
  const head = kept.length > 0
    ? `${paint("╭─", "accent", color)} ${rendered}`
    : paint(truncateToWidth("╭─", Math.max(1, limit), ""), "accent", color);
  return `${head}\n${paint("╰─❯", ["accentStrong", "bold"], color)} `;
}

/** `12.3k↑ 4.5k↓ $0.12` — omitted entirely while the session has spent nothing. */
function formatSpend(usage) {
  if (!usage) return "";
  const input = Number(usage.inputTokens ?? 0);
  const output = Number(usage.outputTokens ?? 0);
  const cost = Number(usage.costUsd ?? 0);
  if (!(input > 0 || output > 0)) return "";
  const tokens = `${formatTokens(input)}↑ ${formatTokens(output)}↓`;
  return cost > 0 ? `${tokens} ${formatUsd(cost)}` : tokens;
}

/**
 * `/status` — the full picture, in the shared panel language.
 *
 * `disabledTools` is what the start-up `[tools] disabled (unsupported
 * environment): …` line used to shout above the banner (P3b-3): the banner now
 * shows a dim one-liner and the reasons live here.
 */
/**
 * Human label for a reasoning display mode (P3-14). Accepts the mode strings
 * from `ReasoningRenderer` (`hidden` / `folded` / `full`) — normalised so a
 * plain boolean (`true` = shown, `false` = hidden) still works.
 */
export function formatThinkingMode(mode) {
  const v = String(mode ?? "").toLowerCase();
  if (v === "hidden" || v === "off" || v === "false") return "hidden";
  if (v === "folded" || v === "fold") return "folded";
  return "shown";
}

export function renderStatus({
  cwd,
  sessionId,
  provider,
  model,
  approvalMode,
  planMode = false,
  usage = null,
  disabledTools = [],
  thinking = null,
  width = 80,
  color = true
} = {}) {
  const rows = [
    ["Workspace", cwd],
    ["Session", sessionId],
    ["Model", `${provider ?? "unconfigured"}:${model ?? "unconfigured"}`],
    ["Approval", approvalMode ?? "default"],
    ["Plan mode", planMode ? "on" : "off"]
  ];
  if (thinking != null) rows.push(["Thinking", formatThinkingMode(thinking)]);
  if (usage && ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0)) {
    rows.push(["Tokens", `${formatTokens(usage.inputTokens ?? 0)} in / ${formatTokens(usage.outputTokens ?? 0)} out`]);
    rows.push(["Cost", formatUsd(usage.costUsd ?? 0)]);
  }
  for (const entry of disabledTools ?? []) {
    rows.push(["Tool off", `${entry?.name ?? "tool"} — ${entry?.reason ?? "unavailable"}`, "muted"]);
  }
  return renderPanel({ title: "Status", rows, width, color });
}

/**
 * `/clear` (P3b-4). `\x1b[2J` only wipes the visible screen — the scrollback
 * kept every previous turn, so "clear" left the terminal full of history one
 * mouse-wheel away. `\x1b[3J` drops the scrollback too.
 */
export function clearTerminal(writer = process.stdout) {
  if (writer?.isTTY) writer.write(`${ESC}[3J${ESC}[2J${ESC}[H`);
}
