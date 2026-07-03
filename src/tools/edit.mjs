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

  const occurrences = findOccurrences(content, oldString);
  if (occurrences.length === 0) {
    return errorResult(`No match for oldString in ${filePath}`);
  }

  if (replaceAll) {
    const updated = content.split(oldString).join(newString);
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
      after: content.slice(offset + oldString.length, offset + oldString.length + 30)
    }));
    return errorResult(
      `oldString appears ${occurrences.length} times in ${filePath}; pass replaceAll: true or supply a longer unique snippet`,
      { candidates }
    );
  }

  const offset = occurrences[0];
  const updated = content.slice(0, offset) + newString + content.slice(offset + oldString.length);
  await writeFile(resolved, updated, "utf8");
  return {
    kind: "edit",
    summary: `Edited ${filePath} (1 occurrence)`,
    data: { path: resolved, replacedCount: 1 }
  };
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
