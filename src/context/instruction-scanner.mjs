import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { getActiveInstructionScanners } from "./scanner-config.mjs";

export async function scanInstructions({ cwd = process.cwd(), settings }) {
  const workspaceDir = path.resolve(cwd);
  const scanners = getActiveInstructionScanners(settings);
  const found = [];

  for (const scanner of scanners) {
    const dirs = getSearchDirs(workspaceDir, scanner.walk ?? "up");
    for (const dir of dirs) {
      for (const filename of scanner.filenames ?? []) {
        const filePath = path.join(dir, filename);
        if (!(await fileExists(filePath))) continue;
        found.push({
          type: "instruction",
          scannerId: scanner.id,
          compatibility: scanner.compatibility ?? "custom",
          path: filePath,
          depth: path.relative(dir, workspaceDir).split(path.sep).filter(Boolean).length,
          content: await readFile(filePath, "utf8")
        });
      }
    }
  }

  return found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
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
