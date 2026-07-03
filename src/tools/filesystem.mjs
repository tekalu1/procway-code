import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Default window per read. Was 200000 — a single big read dumped ~200KB
// into history and was re-sent on every subsequent round (the dominant
// history-growth driver per the 2026-06-07 token audit). 64000 keeps normal
// source files whole; bigger files page via `offset` (the truncation note in
// `content` tells the model exactly how to continue).
const READ_FILE_DEFAULT_MAX_BYTES = 64000;

export async function readTextFile({ filePath, cwd = process.cwd(), maxBytes = READ_FILE_DEFAULT_MAX_BYTES, offset = 0 }) {
  const resolved = resolveAnywhere(cwd, filePath);
  const content = await readFile(resolved, "utf8");
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const end = start + maxBytes;
  const truncated = content.length > end;
  let slice = start > 0 || truncated ? content.slice(start, end) : content;
  if (truncated) {
    // Inline continuation marker: without it models routinely assume the
    // file ended at the cut. data.truncated alone proved too subtle.
    slice += `\n[... truncated at ${end} of ${content.length} chars — call read_file again with offset: ${end} to continue]`;
  }
  const data = {
    path: resolved,
    content: slice,
    truncated,
    totalChars: content.length,
    ...(start > 0 ? { offset: start } : {}),
    ...(truncated ? { nextOffset: end } : {})
  };
  return {
    kind: "read_file",
    summary: summarizeReadFile(resolved, content.length, truncated),
    data
  };
}

export async function listFiles({ dirPath = ".", cwd = process.cwd() }) {
  const resolved = resolveAnywhere(cwd, dirPath);
  const entries = await readdir(resolved, { withFileTypes: true });
  const data = entries.map((entry) => ({
    name: entry.name,
    path: path.join(resolved, entry.name),
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
  }));
  return {
    kind: "list_files",
    summary: `Listed ${data.length} entries in ${shortPath(resolved, cwd)}`,
    data
  };
}

export async function writeTextFile({ filePath, content, cwd = process.cwd() }) {
  const resolved = resolveInsideCwd(cwd, filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  const data = { path: resolved, bytes };
  return {
    kind: "write_file",
    summary: `Wrote ${formatBytes(bytes)} to ${shortPath(resolved, cwd)}`,
    data
  };
}

export async function applyUnifiedPatch({ patch, cwd = process.cwd() }) {
  const filePatches = parseUnifiedPatch(patch);
  const fileResults = [];
  for (const filePatch of filePatches) {
    const targetPath = filePatch.newPath ?? filePatch.oldPath;
    const resolved = resolveInsideCwd(cwd, targetPath);
    const original = filePatch.isCreate ? "" : await readFile(resolved, "utf8");
    const updated = applyFilePatch(original, filePatch);
    if (filePatch.isDelete) {
      await unlink(resolved);
    } else {
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, updated, "utf8");
    }
    fileResults.push({
      path: resolved,
      operation: filePatch.isCreate ? "create" : filePatch.isDelete ? "delete" : "update",
      hunks: filePatch.hunks.length,
      bytes: filePatch.isDelete ? 0 : Buffer.byteLength(updated, "utf8")
    });
  }
  const totalHunks = fileResults.reduce((sum, file) => sum + file.hunks, 0);
  return {
    kind: "apply_patch",
    summary: `Applied ${totalHunks} hunk(s) across ${fileResults.length} file(s)`,
    data: fileResults
  };
}

export async function searchFiles({ query, dirPath = ".", cwd = process.cwd(), maxResults = 50, maxBytesPerMatch = 300 }) {
  const root = resolveAnywhere(cwd, dirPath);
  const matches = [];
  await walkTextFiles(root, async (filePath) => {
    if (matches.length >= maxResults) return;
    const content = await readFile(filePath, "utf8").catch(() => null);
    if (content == null) return;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      if (!lines[index].includes(query)) continue;
      matches.push({
        path: filePath,
        line: index + 1,
        text: lines[index].slice(0, maxBytesPerMatch)
      });
    }
  });
  return {
    kind: "search_files",
    summary: `Found ${matches.length} match(es) for "${truncateInline(query, 40)}" in ${shortPath(root, cwd)}`,
    data: matches
  };
}

function summarizeReadFile(absolutePath, totalLength, truncated) {
  const sizeLabel = formatBytes(totalLength);
  const note = truncated ? " (truncated)" : "";
  return `Read ${sizeLabel}${note} from ${absolutePath}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortPath(absolutePath, cwd) {
  const root = path.resolve(cwd);
  if (absolutePath === root) return ".";
  if (absolutePath.startsWith(`${root}${path.sep}`)) {
    return absolutePath.slice(root.length + 1);
  }
  return absolutePath;
}

function truncateInline(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function resolveAnywhere(cwd, targetPath) {
  const root = path.resolve(cwd);
  return path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
}

function resolveInsideCwd(cwd, targetPath) {
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }
  return resolved;
}

async function walkTextFiles(dir, onFile) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkTextFiles(fullPath, onFile);
    } else if (entry.isFile() && looksTextLike(entry.name)) {
      await onFile(fullPath);
    }
  }
}

function shouldSkip(name) {
  return name === ".git" || name === "node_modules" || name === ".playwright-cli" || name === "coverage";
}

function looksTextLike(name) {
  return /\.(mjs|js|ts|tsx|json|md|txt|yaml|yml|css|html|vue|py|rs|go|java|cs|sh|ps1)$/i.test(name)
    || !name.includes(".");
}

function parseUnifiedPatch(patch) {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let current = null;
  let currentHunk = null;
  let oldPath = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = null;
      currentHunk = null;
      oldPath = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = normalizePatchPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = normalizePatchPath(line.slice(4).trim());
      current = {
        oldPath,
        newPath,
        isCreate: oldPath == null && newPath != null,
        isDelete: oldPath != null && newPath == null,
        hunks: []
      };
      files.push(current);
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!current) throw new Error("Patch hunk found before file header");
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) throw new Error(`Unsupported patch hunk header: ${line}`);
      currentHunk = {
        oldStart: Number(match[1]),
        newStart: Number(match[2]),
        lines: []
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk && (/^[ +\-\\]/.test(line) || line === "")) {
      currentHunk.lines.push(line);
    }
  }

  if (files.length === 0) throw new Error("Patch did not contain any files");
  return files;
}

function normalizePatchPath(patchPath) {
  if (patchPath === "/dev/null") return null;
  return patchPath.replace(/^b\//, "").replace(/^a\//, "");
}

function applyFilePatch(original, filePatch) {
  const originalLines = original.length === 0 ? [] : original.split("\n");
  const output = [];
  let cursor = 0;

  for (const hunk of filePatch.hunks) {
    const hunkStart = Math.max(hunk.oldStart - 1, 0);
    while (cursor < hunkStart) {
      output.push(originalLines[cursor]);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (originalLines[cursor] !== value) {
          throw new Error(`Patch context mismatch in ${filePatch.newPath}`);
        }
        output.push(originalLines[cursor]);
        cursor += 1;
      } else if (marker === "-") {
        if (originalLines[cursor] !== value) {
          throw new Error(`Patch removal mismatch in ${filePatch.newPath}`);
        }
        cursor += 1;
      } else if (marker === "+") {
        output.push(value);
      }
    }
  }

  while (cursor < originalLines.length) {
    output.push(originalLines[cursor]);
    cursor += 1;
  }
  return output.join("\n");
}
