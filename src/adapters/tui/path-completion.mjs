/**
 * `@path` completion (P2-7).
 *
 * `input-preprocessor.mjs` has expanded `@path` into an attached file since
 * Phase 4, but the REPL's completer opened with
 * `if (!line.startsWith("/")) return [[], line]`, so nothing ever completed a
 * file reference — you had to type the path from memory or the feature was
 * invisible. This module supplies the missing half, and `createReplCompleter`
 * is the single completer the input controller is given.
 *
 * The readline completer contract is kept (`[matches, head]`) because the
 * controller replaces exactly `head` with the chosen match.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Matches the `@token` under the cursor, if there is one. */
export const AT_TOKEN_RE = /(?:^|\s)@(\S*)$/;

/**
 * @param {string} token the text after `@` (may contain `/`)
 * @param {string} cwd
 * @returns {[string[], string]} `[["@src/adapters/", …], "@src/ad"]`
 */
export function completeAtPath(token, cwd = process.cwd(), fs = { readdirSync, statSync }) {
  const head = `@${token}`;
  const separator = token.lastIndexOf("/");
  const dirPart = separator === -1 ? "" : token.slice(0, separator + 1);
  const stem = separator === -1 ? token : token.slice(separator + 1);
  const base = path.resolve(cwd, dirPart || ".");
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return [[], head];
  }
  const matches = names
    // Hidden entries only surface once the user has typed the leading dot.
    .filter((name) => name.startsWith(stem) && (stem.startsWith(".") || !name.startsWith(".")))
    .sort()
    .slice(0, 200)
    .map((name) => {
      let suffix = "";
      try { suffix = fs.statSync(path.join(base, name)).isDirectory() ? "/" : ""; } catch { /* ignore */ }
      return `@${dirPart}${name}${suffix}`;
    });
  return [matches, head];
}

/**
 * Build the REPL completer: slash commands at the start of a line, `@paths`
 * anywhere else.
 */
export function createReplCompleter({ cwd = process.cwd(), slashCompleter = null, fs } = {}) {
  return function completer(line) {
    const text = String(line ?? "");
    if (text.startsWith("/") && typeof slashCompleter === "function") {
      const [matches, head] = slashCompleter(text);
      if (matches.length === 0) return [[], head];
      return [matches, head];
    }
    const at = AT_TOKEN_RE.exec(text);
    if (at) return completeAtPath(at[1], cwd, fs ?? { readdirSync, statSync });
    return [[], text];
  };
}
