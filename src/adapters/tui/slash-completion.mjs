import { readFile } from "node:fs/promises";
import path from "node:path";

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
  { name: "/compact", description: "Compact the conversation history", args: "[--strategy <name>] [--keep-last <n>]" },
  { name: "/config", description: "Show the active settings JSON" },
  { name: "/context", description: "Show resolved instructions / skills" },
  { name: "/exit", description: "Leave the REPL" },
  { name: "/history", description: "Print the recent transcript" },
  { name: "/memory", description: "List persisted memory entries" },
  { name: "/model", description: "Show the active provider:model" },
  { name: "/plan", description: "Toggle plan mode (queue write tools for end-of-turn approval)" },
  { name: "/resume", description: "Pick a session to resume" },
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

export function formatMenu(line, { width = 80 } = {}) {
  const head = (line ?? "").split(/\s/)[0];
  const matches = SLASH_COMMANDS.filter((entry) => entry.name.startsWith(head));
  if (matches.length === 0) return "";
  const lines = matches.map((entry) => {
    const args = entry.args ? ` ${entry.args}` : "";
    const desc = entry.description ? ` — ${entry.description}` : "";
    const row = `  ${entry.name}${args}${desc}`;
    return row.length > width ? `${row.slice(0, width - 1)}…` : row;
  });
  return `${lines.join("\n")}\n`;
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
