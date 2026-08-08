/**
 * Persistent REPL history (P2-6).
 *
 * Before Phase 2 the history lived only inside the readline interface, so it
 * died with the process. It now round-trips through
 * `~/.procway/ai-agent/history` — same base directory as the session store
 * (`session/store.mjs#getSessionsDir`), one entry per line with `\n` escaped
 * as `\\n` so a multi-line prompt stays a single history entry.
 *
 * Secrets never reach this module: `InputController.readSecret()` runs its own
 * activity and does not call `record()`. `looksLikeSecret()` is a second belt —
 * a pasted `sk-…` key typed at the normal prompt is dropped too.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MAX_ENTRIES = 500;

export function getHistoryPath({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".procway", "ai-agent", "history");
}

function encode(entry) {
  return String(entry).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function decode(line) {
  let out = "";
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\\" && index + 1 < line.length) {
      const next = line[index + 1];
      if (next === "n") { out += "\n"; index += 1; continue; }
      if (next === "\\") { out += "\\"; index += 1; continue; }
    }
    out += line[index];
  }
  return out;
}

/**
 * Heuristic secret filter. Deliberately conservative — it only matches shapes
 * that are unambiguously credentials, so ordinary prompts are never dropped.
 */
export function looksLikeSecret(value) {
  const text = String(value ?? "");
  if (text.length === 0) return false;
  return (
    /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/.test(text) ||
    /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(text) ||
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(text) ||
    /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text) ||
    /(?:api[_-]?key|secret|token|password)\s*[=:]\s*\S{12,}/i.test(text)
  );
}

export function createInputHistory({ filePath = null, maxEntries = DEFAULT_MAX_ENTRIES, homeDir } = {}) {
  const target = filePath ?? getHistoryPath(homeDir ? { homeDir } : {});
  /** @type {string[]} oldest → newest */
  let entries = [];
  let cursor = 0; // entries.length = "not browsing"
  let draft = "";
  let dirty = false;

  return {
    get path() { return target; },
    get entries() { return entries.slice(); },

    async load() {
      try {
        const text = await readFile(target, "utf8");
        entries = text.split("\n").filter((line) => line !== "").map(decode).slice(-maxEntries);
      } catch {
        entries = [];
      }
      cursor = entries.length;
      return entries.slice();
    },

    /** Add an entry (in memory). Blank, duplicate-of-last and secret-looking
     *  values are skipped. */
    record(value) {
      const text = String(value ?? "");
      cursor = entries.length;
      draft = "";
      if (text.trim() === "") return false;
      if (looksLikeSecret(text)) return false;
      if (entries[entries.length - 1] === text) { cursor = entries.length; return false; }
      entries.push(text);
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
      cursor = entries.length;
      dirty = true;
      return true;
    },

    async save() {
      if (!dirty) return false;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${entries.map(encode).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      dirty = false;
      return true;
    },

    /** Move one entry back. `current` is stashed so Down returns to it. */
    previous(current = "") {
      if (entries.length === 0) return null;
      if (cursor === entries.length) draft = current;
      if (cursor === 0) return entries[0];
      cursor -= 1;
      return entries[cursor];
    },

    /** Move one entry forward; returns the stashed draft past the newest. */
    next() {
      if (cursor >= entries.length) return null;
      cursor += 1;
      if (cursor === entries.length) return draft;
      return entries[cursor];
    },

    reset() {
      cursor = entries.length;
      draft = "";
    }
  };
}
