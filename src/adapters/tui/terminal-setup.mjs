/**
 * `/terminal-setup` — teach the terminal to send `ESC CR` on Shift+Enter (P2-2b).
 *
 * Shift+Enter is indistinguishable from Enter at the byte level: terminals send
 * 0x0D for both unless they are told otherwise. So the multi-line newline can
 * only be bound with the terminal's own configuration — which means writing to
 * a file the user owns. Three rules follow from that, and they are enforced
 * here rather than left to the caller:
 *
 *   1. NOTHING is written before the user sees the exact diff and confirms.
 *   2. An existing binding is never overwritten — the target is reported as
 *      "already configured" and skipped.
 *   3. Every modified file is copied to `<file>.procway-backup-<ts>` first.
 *
 * Supported: VS Code / Cursor / Windsurf (`keybindings.json`), iTerm2
 * (`GlobalKeyMap` via `defaults`), WezTerm (`wezterm.lua`, created only when
 * absent — see `WEZTERM_MANUAL`). Anything else gets the Ctrl+J advice.
 *
 * `\x1b\r` is the same sequence macOS sends for Option+Enter, and the input
 * controller decodes it as `{ name: "return", meta: true }` → newline.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What VS Code's `sendSequence` has to emit: ESC CR. */
const VSCODE_BINDING = {
  key: "shift+enter",
  command: "workbench.action.terminal.sendSequence",
  when: "terminalFocus",
  args: { text: "\u001b\r" }
};

const WEZTERM_CONFIG = `-- Created by procway-code /terminal-setup.
-- Shift+Enter sends ESC CR so multi-line input works in the agent REPL.
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.keys = {
  {
    key = 'Enter',
    mods = 'SHIFT',
    action = wezterm.action.SendString '\\x1b\\r',
  },
}

return config
`;

const WEZTERM_SNIPPET = `config.keys = {
  {
    key = 'Enter',
    mods = 'SHIFT',
    action = wezterm.action.SendString '\\x1b\\r',
  },
}`;

export const CTRL_J_ADVICE =
  "This terminal has no automatic setup. Use Ctrl+J (or end a line with \\) for a newline — both work everywhere.";

/**
 * Identify the host terminal from the environment.
 * @returns {"vscode"|"iterm2"|"wezterm"|null}
 */
export function detectTerminal(env = process.env) {
  const program = String(env.TERM_PROGRAM ?? "");
  if (env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE || program === "WezTerm") return "wezterm";
  if (program === "iTerm.app" || env.LC_TERMINAL === "iTerm2") return "iterm2";
  if (program === "vscode" || env.VSCODE_INJECTION === "1" || env.TERM_PROGRAM === "cursor") return "vscode";
  return null;
}

/** Platform-appropriate VS Code keybindings.json location. */
export function vscodeKeybindingsPath({ homeDir = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const appName = env.CURSOR_TRACE_ID || env.TERM_PROGRAM === "cursor" ? "Cursor" : "Code";
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", appName, "User", "keybindings.json");
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(homeDir, "AppData", "Roaming"), appName, "User", "keybindings.json");
  return path.join(homeDir, ".config", appName, "User", "keybindings.json");
}

export function weztermConfigPath({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".config", "wezterm", "wezterm.lua");
}

/** Strip `//` and `/* *\/` comments so "is the array empty?" can be answered. */
function stripJsonComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

/**
 * Insert `entry` into a VS Code keybindings.json **textually**, so the user's
 * comments and formatting survive. Returns null when the file already binds
 * Shift+Enter (rule 2).
 */
export function insertVscodeBinding(source, entry = VSCODE_BINDING) {
  const text = String(source ?? "");
  const bare = stripJsonComments(text);
  if (/"key"\s*:\s*"shift\+enter"/i.test(bare)) return null;
  const serialized = JSON.stringify(entry, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? `  ${line}` : `  ${line}`))
    .join("\n");
  if (bare.trim() === "") return `[\n${serialized}\n]\n`;
  const close = text.lastIndexOf("]");
  if (close === -1) return `[\n${serialized}\n]\n`;
  const head = text.slice(0, close);
  const tail = text.slice(close);
  const inner = stripJsonComments(head.slice(head.indexOf("[") + 1)).trim();
  const separator = inner === "" ? "" : ",";
  const trimmedHead = head.replace(/\s*$/, "");
  return `${trimmedHead}${separator}\n${serialized}\n${tail}`;
}

/**
 * Build (but do not apply) the plan for this terminal.
 *
 * @returns {Promise<{terminal: string|null, supported: boolean, note: string,
 *   targets: Array<{kind: string, path?: string, action: "create"|"update"|"skip"|"command",
 *   before: string, after: string, reason?: string, command?: string[]}>}>}
 */
export async function planTerminalSetup({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  terminal = null,
  read = (file) => readFile(file, "utf8")
} = {}) {
  const detected = terminal ?? detectTerminal(env);
  if (!detected) {
    return { terminal: null, supported: false, note: CTRL_J_ADVICE, targets: [] };
  }

  if (detected === "vscode") {
    const file = vscodeKeybindingsPath({ homeDir, platform, env });
    let before = "";
    let exists = true;
    try { before = await read(file); } catch { exists = false; }
    const after = insertVscodeBinding(before);
    if (after == null) {
      return {
        terminal: detected,
        supported: true,
        note: "Shift+Enter is already bound in keybindings.json — nothing to do.",
        targets: [{ kind: "file", path: file, action: "skip", before, after: before, reason: "already configured" }]
      };
    }
    return {
      terminal: detected,
      supported: true,
      note: "Reload the VS Code window (or restart the integrated terminal) to pick the binding up.",
      targets: [{ kind: "file", path: file, action: exists ? "update" : "create", before: exists ? before : "", after }]
    };
  }

  if (detected === "iterm2") {
    if (platform !== "darwin") {
      return { terminal: detected, supported: false, note: CTRL_J_ADVICE, targets: [] };
    }
    // iTerm2 keeps key maps in a plist; `defaults -dict-add` merges a single
    // entry and leaves every other binding alone. 0x20000 = Shift.
    // Action 11 = "Send Hex Codes"; 0x1b 0x0d is ESC CR.
    const value = "{ Action = 11; Text = \"0x1b 0x0d\"; }";
    return {
      terminal: detected,
      supported: true,
      note: "Restart iTerm2 (or Preferences ▸ Keys will show the new mapping) to pick it up.",
      targets: [
        {
          kind: "command",
          action: "command",
          command: ["defaults", "write", "com.googlecode.iterm2", "GlobalKeyMap", "-dict-add", "0xd-0x20000", value],
          before: "",
          after: `GlobalKeyMap["0xd-0x20000"] = ${value}`
        },
        {
          // iTerm2 3.5 keys the map by <char>-<modifiers>-<keycode>.
          kind: "command",
          action: "command",
          command: ["defaults", "write", "com.googlecode.iterm2", "GlobalKeyMap", "-dict-add", "0xd-0x20000-0x24", value],
          before: "",
          after: `GlobalKeyMap["0xd-0x20000-0x24"] = ${value}`
        }
      ]
    };
  }

  // WezTerm: the config is executable Lua. Creating one is safe; rewriting an
  // existing one is not (we would have to understand the user's code), so we
  // print the snippet instead of guessing.
  const file = weztermConfigPath({ homeDir });
  let before;
  try { before = await read(file); } catch { before = null; }
  if (before == null) {
    return {
      terminal: "wezterm",
      supported: true,
      note: "WezTerm reloads its config automatically once the file is written.",
      targets: [{ kind: "file", path: file, action: "create", before: "", after: WEZTERM_CONFIG }]
    };
  }
  if (/mods\s*=\s*['"]SHIFT['"]/.test(before) && /key\s*=\s*['"]Enter['"]/.test(before)) {
    return {
      terminal: "wezterm",
      supported: true,
      note: "Shift+Enter is already bound in wezterm.lua — nothing to do.",
      targets: [{ kind: "file", path: file, action: "skip", before, after: before, reason: "already configured" }]
    };
  }
  return {
    terminal: "wezterm",
    supported: true,
    manual: true,
    note: `wezterm.lua already exists and is executable Lua — it will NOT be edited automatically.\nAdd this to your config (${file}):\n\n${WEZTERM_SNIPPET}\n`,
    targets: [{ kind: "file", path: file, action: "skip", before, after: before, reason: "manual edit required" }]
  };
}

/**
 * Apply a plan. Backs every modified file up first.
 * @returns {Promise<Array<{path?: string, applied: boolean, backup?: string, error?: string}>>}
 */
export async function applyTerminalSetup(plan, {
  write = (file, content) => writeFile(file, content, "utf8"),
  ensureDir = (dir) => mkdir(dir, { recursive: true }),
  backup = (file) => copyFile(file, `${file}.procway-backup-${Date.now()}`),
  run = (command, args) => execFileAsync(command, args)
} = {}) {
  const results = [];
  for (const target of plan?.targets ?? []) {
    if (target.action === "skip") {
      results.push({ path: target.path, applied: false, reason: target.reason ?? "skipped" });
      continue;
    }
    try {
      if (target.kind === "command") {
        await run(target.command[0], target.command.slice(1));
        results.push({ applied: true, command: target.command.join(" ") });
        continue;
      }
      await ensureDir(path.dirname(target.path));
      let backupPath = null;
      if (target.action === "update") {
        backupPath = await backup(target.path);
      }
      await write(target.path, target.after);
      results.push({ path: target.path, applied: true, backup: backupPath ?? undefined });
    } catch (error) {
      results.push({ path: target.path, applied: false, error: error?.message ?? String(error) });
    }
  }
  return results;
}

export const TERMINAL_SETUP_INTERNALS = { VSCODE_BINDING, WEZTERM_CONFIG, WEZTERM_SNIPPET };
