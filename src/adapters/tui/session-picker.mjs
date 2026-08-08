/**
 * Interactive session picker.
 *
 * P2-1: the picker does not touch raw mode. It borrows the shared key stream
 * through `controller.withExclusiveKeys()` — the prompt underneath is
 * suspended and repainted when the picker closes, so stdin has exactly one
 * owner throughout. (The pre-Phase-2 fallback that called
 * `readline.emitKeypressEvents` + `setRawMode(true)` itself was dead code in
 * this repository and is gone; callers without a controller get the non-TTY
 * listing.)
 *
 * P3b-5 rebuilt the rendering and the key map:
 *
 *  - it used to `\x1b[2J\x1b[H` and re-print the WHOLE list on every keypress,
 *    so three presses of ↓ pushed three full copies into the scrollback. The
 *    frame is now redrawn in place (cursor up N rows → clear → repaint), the
 *    same technique `line-editor.mjs` uses;
 *  - up to 200 sessions were printed at once with no paging. Now one screenful
 *    at a time with PgUp/PgDn and a page counter;
 *  - the columns were space-joined and never lined up. Now `padEnd`-aligned;
 *  - Enter was `key.name === "return"` only, so a plain LF (`printf '\n'`,
 *    every non-interactive driver) hung forever. `linefeed` is accepted too;
 *  - the rows showed an ISO timestamp and `(untitled)`. Now: relative time,
 *    message count, title, model.
 */

import { padEnd, style, terminalHeight, terminalWidth, truncateToWidth, visibleWidth } from "./ansi.mjs";
import { formatRelativeTime } from "./format.mjs";
import { singleLine } from "./panel.mjs";
import { sanitizeTerminalText } from "./sanitize.mjs";

export const MIN_PAGE_SIZE = 3;
export const MAX_PAGE_SIZE = 12;

/** How many rows fit between the header and the footer of the picker frame. */
export function resolvePageSize({ rows = 24, total = 0 } = {}) {
  const available = Math.max(MIN_PAGE_SIZE, (Number(rows) || 24) - 6);
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, available, Math.max(total, 1)));
}

/**
 * Pure frame builder — the exact lines the picker paints, so tests can assert
 * paging and alignment without a terminal.
 *
 * @returns {{ lines: string[] }}
 */
export function renderPickerFrame({ sessions, selected = 0, pageSize = 10, width = 80, color = false, now = Date.now() } = {}) {
  const total = sessions.length;
  const page = Math.floor(selected / pageSize);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const visible = sessions.slice(page * pageSize, page * pageSize + pageSize);
  // The cells below are already collapsed by `singleLine`; this is the backstop
  // for the glyphs and the assembled row. It must preserve the padding spaces
  // that align the columns, so it is the non-inline form.
  const paint = (value, names) => {
    const text = sanitizeTerminalText(value);
    return color ? style(names, text) : text;
  };

  const cells = visible.map((session) => ({
    when: formatRelativeTime(session?.updatedAt, { now }) || "unknown",
    count: `${Number(session?.messageCount ?? 0)} msg${Number(session?.messageCount ?? 0) === 1 ? "" : "s"}`,
    // A title is the first user message, so it often has newlines in it — one
    // of those would add rows the in-place repaint did not count.
    title: singleLine(session?.title) || "(untitled)",
    model: singleLine(session?.model) || "-"
  }));
  const whenWidth = maxWidth(cells.map((cell) => cell.when));
  const countWidth = maxWidth(cells.map((cell) => cell.count));
  const modelWidth = Math.min(24, maxWidth(cells.map((cell) => cell.model)));
  // 2 (marker) + gaps(3×2) + the three fixed columns; whatever is left is the
  // title, which is the column worth giving the slack to.
  const titleWidth = Math.max(8, width - 2 - whenWidth - countWidth - modelWidth - 6);

  const lines = [
    `${paint("▌", "accent")} ${paint("Resume a session", ["accentStrong", "bold"])}  ${paint(`${total} session${total === 1 ? "" : "s"}`, "muted")}`,
    `  ${paint("↑↓ move · PgUp/PgDn page · Enter resume · q cancel", "muted")}`,
    ""
  ];
  for (let index = 0; index < visible.length; index += 1) {
    const absolute = page * pageSize + index;
    const isSelected = absolute === selected;
    const cell = cells[index];
    const body = [
      padEnd(cell.when, whenWidth),
      padEnd(cell.count, countWidth),
      padEnd(truncateToWidth(cell.title, titleWidth), titleWidth),
      truncateToWidth(cell.model, modelWidth)
    ].join("  ").replace(/\s+$/, "");
    lines.push(isSelected
      ? `${paint("❯", "accentStrong")} ${paint(body, ["accentStrong", "bold"])}`
      : `  ${paint(body, "muted")}`);
  }
  lines.push("");
  lines.push(`  ${paint(`page ${page + 1}/${pageCount}`, "muted")}`);
  return { lines };
}

function maxWidth(values) {
  return values.reduce((max, value) => Math.max(max, visibleWidth(value)), 0);
}

/**
 * Shared key vocabulary. Exported so the key map is testable on its own.
 *
 * @returns {{ action: "render"|"accept"|"cancel"|null, selected: number }}
 */
export function stepSelection({ name, ctrl = false, selected = 0, total = 0, pageSize = 10 }) {
  if (total === 0) return { action: "cancel", selected };
  const wrap = (value) => ((value % total) + total) % total;
  if (name === "up" || name === "k" || (ctrl && name === "p")) return { action: "render", selected: wrap(selected - 1) };
  if (name === "down" || name === "j" || (ctrl && name === "n")) return { action: "render", selected: wrap(selected + 1) };
  if (name === "pageup" || (ctrl && name === "b")) return { action: "render", selected: Math.max(0, selected - pageSize) };
  if (name === "pagedown" || (ctrl && name === "f")) return { action: "render", selected: Math.min(total - 1, selected + pageSize) };
  if (name === "home") return { action: "render", selected: 0 };
  if (name === "end") return { action: "render", selected: total - 1 };
  // `linefeed` matters: a driver that writes a bare "\n" (printf, a here-doc,
  // any CI harness) produces LF, not CR, and the old picker ignored it and
  // hung forever.
  if (name === "return" || name === "linefeed" || name === "enter") return { action: "accept", selected };
  if (name === "escape" || name === "q" || (ctrl && name === "c")) return { action: "cancel", selected };
  return { action: null, selected };
}

export async function pickSession({ sessions, input = process.stdin, output = process.stdout, controller = null, now = () => Date.now() } = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  if (!input?.isTTY || !output?.isTTY || !controller) {
    printSessionChoices({ sessions, output });
    return sessions[0];
  }

  let selected = 0;
  let drawnRows = 0;
  const colorful = output.isTTY === true;
  const pageSizeNow = () => resolvePageSize({ rows: terminalHeight(output), total: sessions.length });

  function paintFrame() {
    const { lines } = renderPickerFrame({
      sessions,
      selected,
      pageSize: pageSizeNow(),
      // Read the geometry per paint so a resize reflows the frame (P3b-11).
      width: terminalWidth(output),
      color: colorful,
      now: now()
    });
    // In-place repaint: rewind over what we drew last time, clear to the end
    // of the screen, then write the new frame. Nothing accumulates in the
    // scrollback (P3b-5).
    let out = "";
    if (drawnRows > 0) out += `\x1b[${drawnRows}A`;
    out += "\r\x1b[0J";
    out += lines.join("\r\n");
    drawnRows = Math.max(0, lines.length - 1);
    output.write(out);
  }

  function closeFrame() {
    // Leave the cursor on a fresh line below the frame.
    output.write("\r\n");
    drawnRows = 0;
  }

  // A resize invalidates the row bookkeeping: repaint from scratch.
  const onResize = () => { drawnRows = 0; paintFrame(); };
  output.on?.("resize", onResize);

  try {
    return await controller.withExclusiveKeys(
      (event, api) => {
        const name = event.type === "text" ? event.text : event.name;
        const { action, selected: next } = stepSelection({
          name,
          ctrl: event.ctrl === true,
          selected,
          total: sessions.length,
          pageSize: pageSizeNow()
        });
        selected = next;
        if (action === "render") paintFrame();
        else if (action === "accept") { closeFrame(); api.finish(sessions[selected]); }
        else if (action === "cancel") { closeFrame(); api.finish(null); }
      },
      {
        onStart: () => { drawnRows = 0; paintFrame(); },
        onResume: () => { drawnRows = 0; paintFrame(); }
      }
    );
  } finally {
    output.removeListener?.("resize", onResize);
  }
}

export function printSessionChoices({ sessions, output = process.stdout }) {
  for (const session of sessions) {
    output.write(`${formatSession(session)}\n`);
  }
}

/**
 * Plain columnar form used for piped stdout (scripts parse this).
 *
 * The interactive frame above sanitises through `singleLine`; this route did
 * not, and it is the one that ends up in a file. A session title is the first
 * user message — which, for a session started by `procway-code -p "$(cat …)"`
 * or resumed from a shared transcript, is not necessarily text this user wrote.
 */
function formatSession(session) {
  return [
    singleLine(session.sessionId),
    singleLine(session.updatedAt) || "-",
    singleLine(session.model) || "-",
    singleLine(session.title) || "(untitled)"
  ].join("  ");
}
