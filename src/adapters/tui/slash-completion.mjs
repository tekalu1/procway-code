import { readFile } from "node:fs/promises";
import path from "node:path";
import { padEnd, visibleWidth } from "./ansi.mjs";
import { wrapText } from "./panel.mjs";

/**
 * Slash-command completion. Pure data so the readline `completer` callback
 * stays synchronous.
 *
 *   const completer = createSlashCompleter();
 *   const [matches, key] = completer("/co");  // => [["/compact", "/config", "/context"], "/co"]
 *
 * Each command may declare an `args` template (e.g. `from <messageId>`) used
 * by the menu renderer to show parameter hints.
 */

export const SLASH_COMMANDS = Object.freeze([
  { name: "/branch", description: "Branch the conversation from a message id (/branch from <messageId>)", args: "from <messageId>" },
  { name: "/checkout", description: "Resume a branch session by id", args: "<branchSessionId>" },
  { name: "/clear", description: "Clear the terminal while keeping the session" },
  { name: "/compact", description: "Compact the conversation history", args: "[--strategy <name>] [--keep-last <n>]" },
  { name: "/config", description: "Show settings or configure a provider interactively (/config setup)", args: "[setup]" },
  { name: "/context", description: "Show resolved instructions / skills" },
  { name: "/exit", description: "Leave the REPL" },
  { name: "/help", description: "List all slash commands with a one-line description" },
  { name: "/history", description: "Print the recent transcript" },
  { name: "/memory", description: "List persisted memory entries" },
  { name: "/mcp", description: "List MCP servers, or add/remove/reconnect one", args: "[add|remove|reconnect]" },
  { name: "/model", description: "Show the active provider:model" },
  { name: "/plan", description: "Toggle plan mode (queue write tools for end-of-turn approval)" },
  { name: "/resume", description: "Pick a session to resume" },
  { name: "/status", description: "Show workspace, session, model, and mode" },
  { name: "/terminal-setup", description: "Bind Shift+Enter to a newline in this terminal (shows a diff first)" },
  { name: "/thinking", description: "Control the model's reasoning display: off (hidden), fold (one-line summary), full (stream)", args: "[off|fold|full]" },
  { name: "/todos", description: "Show the agent's running todo list" },
  { name: "/usage", description: "Show round-by-round usage / cost" }
]);

export function createSlashCompleter(commands = SLASH_COMMANDS) {
  return function complete(line) {
    const trimmed = line ?? "";
    if (!trimmed.startsWith("/")) return [[], trimmed];
    const head = trimmed.split(/\s/)[0];
    const matches = commands
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(head));
    return [matches, head];
  };
}

export function describeCommand(name) {
  return SLASH_COMMANDS.find((entry) => entry.name === name) ?? null;
}

/**
 * Render one command as `  /name <args>   description`, wrapping the
 * description into a hanging-indent column instead of cutting it mid-word
 * (P3b-7 — `/help` used to end rows with "keeping the sessio…").
 *
 * @param {{ name: string, args?: string, description?: string }} entry
 * @param {number} width      total columns available
 * @param {number} nameWidth  width of the shared name column
 */
function formatCommandRow(entry, width, nameWidth) {
  const args = entry.args ? ` ${entry.args}` : "";
  const name = `  ${entry.name}${args}`;
  if (!entry.description) return name;
  const gap = 2;
  const column = nameWidth;
  const descWidth = width - column - gap;
  // Too narrow for a two-column layout: stack the description underneath.
  if (descWidth < 24) {
    const stacked = wrapText(entry.description, Math.max(8, width - 4));
    return [name, ...stacked.map((row) => `    ${row}`)].join("\n");
  }
  const rows = wrapText(entry.description, descWidth);
  // A long `args` template (e.g. /compact) would otherwise widen the column
  // for all 18 commands: let it have its own row instead.
  if (visibleWidth(name) > column) {
    return [name, ...rows.map((row) => `${" ".repeat(column + gap)}${row}`)].join("\n");
  }
  return rows
    .map((row, index) => `${index === 0 ? padEnd(name, column) : " ".repeat(column)}${" ".repeat(gap)}${row}`)
    .join("\n");
}

/**
 * The shared name column: as wide as the widest command, but never more than
 * ~a third of the terminal (a single long args template must not push every
 * description off the right edge).
 */
function nameColumnWidth(commands, width = 80) {
  const widest = commands.reduce(
    (max, entry) => Math.max(max, visibleWidth(`  ${entry.name}${entry.args ? ` ${entry.args}` : ""}`)),
    0
  );
  return Math.min(widest, Math.max(16, Math.floor(width / 3)));
}

/**
 * The listing printed when a `/xx` line was SUBMITTED and matched no command.
 *
 * The live, incremental menu is `completion-menu.mjs` (P3b-7): it serves
 * `/commands` and `@paths` from one source and is drawn as the input region's
 * footer with a movable selection, so nothing lands in the scrollback.
 */
export function formatMenu(line, { width = 80 } = {}) {
  const head = (line ?? "").split(/\s/)[0];
  const matches = SLASH_COMMANDS.filter((entry) => entry.name.startsWith(head));
  if (matches.length === 0) return "";
  const column = nameColumnWidth(matches, width);
  return `${matches.map((entry) => formatCommandRow(entry, width, column)).join("\n")}\n`;
}

/** Bare command names in declaration order — the compact startup banner list. */
export function slashCommandNames(commands = SLASH_COMMANDS) {
  return commands.map((entry) => entry.name);
}

/**
 * Full `/help` listing: every slash command with its one-line description,
 * derived from the same SLASH_COMMANDS source as completion and the banner.
 */
export function formatSlashHelp(commands = SLASH_COMMANDS, { width = 80 } = {}) {
  const column = nameColumnWidth(commands, width);
  return commands.map((entry) => formatCommandRow(entry, width, column)).join("\n");
}

/**
 * Search for a SKILL.md file matching a slash-command name.
 *
 * Search order per TK-132 R2:
 *   1. .claude/skills/{name}/SKILL.md  (claude-compat skills)
 *   2. skills/{name}/SKILL.md          (shared skills)
 *
 * @param {{ cwd: string, name: string }} opts
 * @returns {Promise<{ path: string, content: string, name: string } | null>}
 */
export async function findSkillMd({ cwd, name }) {
  if (!name || typeof name !== "string") return null;
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safe.length === 0) return null;

  const candidates = [
    path.resolve(cwd, ".claude", "skills", safe, "SKILL.md"),
    path.resolve(cwd, "skills", safe, "SKILL.md")
  ];

  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf8");
      return { path: candidate, content, name: safe };
    } catch {
      // not found at this location, try next
    }
  }
  return null;
}

/**
 * Return true when `name` matches one of the built-in slash commands.
 * Useful so callers can skip SKILL.md lookup for known commands.
 *
 * @param {string} name  e.g. "/exit" or "exit"
 */
export function isBuiltinSlashCommand(name) {
  const key = name.startsWith("/") ? name : `/${name}`;
  return SLASH_COMMANDS.some((entry) => entry.name === key);
}

/** Extract the skill name from a slash-command line (strip the leading "/"). */
export function slashCommandName(line) {
  if (!line || typeof line !== "string") return "";
  return line.replace(/^\//, "").trim();
}
