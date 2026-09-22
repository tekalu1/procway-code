import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Replace `oldString` with `newString` inside a workspace file.
 *
 * - `replaceAll: false` (default) requires `oldString` to occur exactly once.
 *   0 or 2+ matches return an error ToolResult — for 2+ matches the
 *   `data.candidates` field carries `{ line, column, before, after }` for each
 *   occurrence so the caller can disambiguate.
 * - `replaceAll: true` replaces every occurrence and reports the count.
 * - `oldString === newString` is rejected (no-op edit).
 * - A snippet sent with `\n` still matches a CRLF file; the replacement is
 *   written with the file's own line endings (see `matchEdit`).
 * - Paths must resolve inside `cwd`.
 */
export async function editFile({ cwd = process.cwd(), filePath, oldString, newString, replaceAll = false }) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return errorResult("filePath is required");
  }
  if (typeof oldString !== "string" || oldString.length === 0) {
    return errorResult("oldString must be a non-empty string");
  }
  if (typeof newString !== "string") {
    return errorResult("newString must be a string");
  }
  if (oldString === newString) {
    return errorResult("oldString and newString must differ");
  }

  let resolved;
  try {
    resolved = resolveInsideCwd(cwd, filePath);
  } catch (error) {
    return errorResult(error.message);
  }

  let content;
  try {
    content = await readFile(resolved, "utf8");
  } catch (error) {
    return errorResult(`Failed to read ${filePath}: ${error.message}`);
  }

  const { needle, replacement, offsets: occurrences } = matchEdit(content, oldString, newString);
  if (occurrences.length === 0) {
    return errorResult(`No match for oldString in ${filePath}`);
  }

  if (replaceAll) {
    const updated = content.split(needle).join(replacement);
    await writeFile(resolved, updated, "utf8");
    return {
      kind: "edit",
      summary: `Edited ${filePath} (${occurrences.length} occurrences)`,
      data: { path: resolved, replacedCount: occurrences.length }
    };
  }

  if (occurrences.length > 1) {
    const candidates = occurrences.map((offset) => ({
      offset,
      ...locateLineColumn(content, offset),
      before: content.slice(Math.max(0, offset - 30), offset),
      after: content.slice(offset + needle.length, offset + needle.length + 30)
    }));
    return errorResult(
      `oldString appears ${occurrences.length} times in ${filePath}; pass replaceAll: true or supply a longer unique snippet`,
      { candidates }
    );
  }

  const offset = occurrences[0];
  const updated = content.slice(0, offset) + replacement + content.slice(offset + needle.length);
  await writeFile(resolved, updated, "utf8");
  return {
    kind: "edit",
    summary: `Edited ${filePath} (1 occurrence)`,
    data: { path: resolved, replacedCount: 1 }
  };
}

/**
 * Locate `oldString` in `content`, tolerating a line-ending mismatch.
 *
 * Models send `\n` even when the file on disk uses `\r\n`, so a verbatim
 * search never finds a multi-line snippet in a CRLF file. An exact match still
 * wins; otherwise the snippet is retried with the file's line endings.
 * `replacement` is `newString` in those same line endings, so an edit never
 * introduces a mix the file did not already have.
 */
export function matchEdit(content, oldString, newString) {
  if (oldString.length === 0) return { needle: oldString, replacement: newString, offsets: [] };
  const eol = lineEnding(content);
  const exact = findOccurrences(content, oldString);
  if (exact.length > 0) {
    return { needle: oldString, replacement: eol ? toLineEnding(newString, eol) : newString, offsets: exact };
  }
  for (const candidate of eol ? [eol] : ["\r\n", "\n"]) {
    const needle = toLineEnding(oldString, candidate);
    if (needle === oldString) continue;
    const offsets = findOccurrences(content, needle);
    if (offsets.length > 0) return { needle, replacement: toLineEnding(newString, candidate), offsets };
  }
  return { needle: oldString, replacement: newString, offsets: [] };
}

// "\r\n" or "\n" when every line break agrees; null for mixed or single-line content.
function lineEnding(content) {
  let lf = 0;
  let crlf = 0;
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
    lf += 1;
    if (i > 0 && content.charCodeAt(i - 1) === 13) crlf += 1;
  }
  if (lf === 0) return null;
  if (crlf === 0) return "\n";
  return crlf === lf ? "\r\n" : null;
}

function toLineEnding(text, eol) {
  return text.replace(/\r?\n/g, eol);
}

function findOccurrences(content, needle) {
  const offsets = [];
  let index = 0;
  while ((index = content.indexOf(needle, index)) !== -1) {
    offsets.push(index);
    index += needle.length;
  }
  return offsets;
}

function locateLineColumn(content, offset) {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

function resolveInsideCwd(cwd, targetPath) {
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }
  return resolved;
}

function errorResult(message, extra = {}) {
  return {
    kind: "edit",
    summary: `Edit failed: ${message}`,
    data: { error: message, ...extra }
  };
}
