import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getActiveInstructionScanners } from "./scanner-config.mjs";

export async function scanInstructions({ cwd = process.cwd(), settings }) {
  const workspaceDir = path.resolve(cwd);
  const scanners = getActiveInstructionScanners(settings);
  const found = [];
  const seen = new Set();

  for (const scanner of scanners) {
    const dirs = getSearchDirs(workspaceDir, scanner.walk ?? "up");
    for (const dir of dirs) {
      for (const filename of scanner.filenames ?? []) {
        await collect(seen, found, path.join(dir, filename), scanner, workspaceDir);
        // Claude Code 相当: same-name file inside a project-local subdirectory
        // (e.g. ./.claude/CLAUDE.md) is discovered per search dir.
        for (const subdir of scanner.subdirs ?? []) {
          await collect(seen, found, path.join(dir, subdir, filename), scanner, workspaceDir);
        }
      }
    }
    if (scanner.userScope) {
      // Claude Code 相当: user-scope ~/.claude/<filename>, lowest priority.
      const userDir = path.join(os.homedir(), ".claude");
      for (const filename of scanner.filenames ?? []) {
        await collect(seen, found, path.join(userDir, filename), scanner, workspaceDir);
      }
    }
  }

  return found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}

async function collect(seen, found, filePath, scanner, workspaceDir) {
  const resolved = path.resolve(filePath);
  // Dedup across expansion strategies (e.g. a subdir path that also satisfies
  // the user-scope location) — first wins.
  if (seen.has(resolved)) return;
  seen.add(resolved);
  if (!(await fileExists(resolved))) return;
  found.push({
    type: "instruction",
    scannerId: scanner.id,
    compatibility: scanner.compatibility ?? "custom",
    path: resolved,
    // Depth counts segments of the file relative to the workspace, so the
    // nearest-most files sort first: ./CLAUDE.md < ./.claude/CLAUDE.md <
    // ~/.claude/CLAUDE.md (user scope). Shared with prompt-builder's first-N
    // slice. Purely a stable sort key — not surfaced to the model.
    depth: relativeDepth(resolved, workspaceDir),
    content: await readFile(resolved, "utf8")
  });
}

function relativeDepth(filePath, workspaceDir) {
  const rel = path.relative(workspaceDir, filePath);
  return rel.split(path.sep).filter(Boolean).length;
}

function getSearchDirs(workspaceDir, walk) {
  if (walk === "current-only") return [workspaceDir];
  if (walk === "down") return [workspaceDir];
  const dirs = [];
  let current = workspaceDir;
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
