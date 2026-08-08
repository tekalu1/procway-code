/**
 * The incremental completion overlay (P3b-7).
 *
 * Typing `/` used to do nothing until you pressed Tab, and Tab printed a flat
 * `  /compact  /config  /context` line into the scrollback. This module is the
 * data + rendering half of the Claude-Code-style menu that replaced it:
 *
 *   ❯ /compact [--strategy <name>] …  Compact the conversation history
 *     /config [setup]                 Show settings or configure a provider…
 *     /context                        Show resolved instructions / skills
 *     … and 2 more
 *
 * The controller draws it as the input region's FOOTER (line-editor.mjs), so
 * it repaints in place and disappears with the prompt — nothing is ever left
 * in the scrollback.
 *
 * The same source serves `/` commands and `@path` references: both come from
 * `createReplCompleter`, so the two feel identical, which is the point.
 */

import { padEnd, style, truncateToWidth, visibleWidth } from "./ansi.mjs";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.mjs";
import { createReplCompleter } from "./path-completion.mjs";
import { createSlashCompleter, describeCommand } from "./slash-completion.mjs";

/** Rows shown at once before the `… and N more` tail. */
export const MENU_LIMIT = 8;

/**
 * Build the menu source used by the REPL prompt.
 *
 * @param {{ cwd?: string, completer?: (line: string) => [string[], string], limit?: number }} options
 * @returns {(textBeforeCursor: string) => { token: string, items: Array<{ value: string, label: string, description: string }>, total: number } | null}
 */
export function createCompletionSource({
  cwd = process.cwd(),
  completer = createReplCompleter({ cwd, slashCompleter: createSlashCompleter() }),
  limit = MENU_LIMIT
} = {}) {
  return function complete(textBeforeCursor) {
    const text = String(textBeforeCursor ?? "");
    let matches;
    let token;
    try {
      const result = completer(text);
      matches = Array.isArray(result?.[0]) ? result[0] : [];
      token = String(result?.[1] ?? "");
    } catch {
      return null;
    }
    if (matches.length === 0) return null;
    // Exactly one match, already typed in full: the user knows what they want,
    // and keeping the menu open would swallow the Enter that submits it.
    if (matches.length === 1 && matches[0] === token) return null;
    const items = matches.slice(0, Math.max(1, limit)).map((value) => toItem(value));
    return { token, items, total: matches.length };
  };
}

function toItem(value) {
  const command = describeCommand(value);
  if (command) {
    return {
      value,
      label: command.args ? `${value} ${command.args}` : value,
      description: command.description ?? ""
    };
  }
  // `@path` completion: `value` is a directory entry read off the filesystem.
  // POSIX allows every byte but `/` and NUL in a file name, so a checked-out
  // repository can carry one called $'\e]52;c;…\a'. `value` itself is left
  // alone — it is what gets inserted into the buffer, and the editor holds it
  // as data — but `label` is what we PAINT.
  return { value, label: sanitizeInline(value), description: "" };
}

/**
 * Render the menu rows. Returns "" when there is nothing to show, which is
 * also the signal to the editor that it has no footer.
 *
 * @param {{ items: Array<object>, selected?: number, total?: number, width?: number, color?: boolean }} params
 */
export function renderCompletionMenu({ items = [], selected = 0, total = items.length, width = 80, color = false } = {}) {
  if (items.length === 0) return "";
  // Sanitise on the way in — the menu is drawn as the input region's FOOTER,
  // so anything that moved the cursor here would desync the editor's row
  // bookkeeping as well as being an injection.
  // `sanitizeTerminalText` here (not the inline form): `paint` also colours the
  // `"❯ "` marker, whose trailing space is the column alignment. The label and
  // description — the parts that actually come from the filesystem — are
  // collapsed to one line individually below.
  const paint = (value, names) => {
    const text = sanitizeTerminalText(value);
    return color ? style(names, text) : text;
  };
  const labelWidth = items.reduce((max, item) => Math.max(max, visibleWidth(sanitizeInline(item.label))), 0);
  // Descriptions get whatever is left; the label column never eats more than
  // half the terminal.
  const column = Math.min(labelWidth, Math.max(12, Math.floor(width / 2)));
  const rows = items.map((item, index) => {
    const isSelected = index === selected;
    const marker = isSelected ? "❯ " : "  ";
    const label = padEnd(truncateToWidth(sanitizeInline(item.label), column), column);
    const room = width - visibleWidth(marker) - column - 2;
    const description = item.description && room >= 8
      ? `  ${truncateToWidth(sanitizeInline(item.description), room)}`
      : "";
    const body = `${label}${description}`.replace(/\s+$/, "");
    return isSelected
      ? `${paint(marker, "accentStrong")}${paint(body, ["accentStrong", "bold"])}`
      : `${marker}${paint(body, "muted")}`;
  });
  if (total > items.length) {
    rows.push(`  ${paint(`… and ${total - items.length} more`, "muted")}`);
  }
  return rows.join("\n");
}
