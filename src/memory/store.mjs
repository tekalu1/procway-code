import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseMemoryFile, serializeMemoryFile } from "./parser.mjs";

/**
 * On-disk layout under `~/.procway/ai-agent/memory/`:
 *
 *   MEMORY.md                 # one-line index
 *   user_role.md              # type=user
 *   feedback_no_mocks.md      # type=feedback
 *   project_tk124.md          # type=project
 *   reference_grafana.md      # type=reference
 *
 * Directory location is configurable via `homeDir` so tests can isolate
 * writes — production callers leave it unset to fall back to `os.homedir()`.
 */

export function getMemoryDir({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".procway", "ai-agent", "memory");
}

/**
 * Read every memory file and the MEMORY.md index. Returns `null` if the
 * directory does not exist (no memory configured for this user).
 */
export async function loadMemoryIndex({ homeDir = os.homedir() } = {}) {
  const dir = getMemoryDir({ homeDir });
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir).catch(() => []);
  const memories = [];
  let indexContent = "";
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const info = await stat(fullPath).catch(() => null);
    if (!info?.isFile()) continue;
    const raw = await readFile(fullPath, "utf8").catch(() => null);
    if (raw == null) continue;
    if (entry.toUpperCase() === "MEMORY.MD") {
      indexContent = raw;
      continue;
    }
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const parsed = parseMemoryFile(raw);
    memories.push({
      file: entry,
      path: fullPath,
      ...parsed
    });
  }
  const types = countTypes(memories);
  return { dir, indexContent, memories, types };
}

export async function writeMemory({ homeDir = os.homedir(), name, description, type, body, fileName }) {
  if (!name || typeof name !== "string") throw new TypeError("writeMemory: name is required");
  const dir = getMemoryDir({ homeDir });
  await mkdir(dir, { recursive: true });
  const targetName = fileName ?? deriveFileName({ name, type });
  const targetPath = path.join(dir, targetName);
  const action = existsSync(targetPath) ? "update" : "create";
  await writeFile(targetPath, serializeMemoryFile({ name, description, type, body }), "utf8");
  await rewriteIndex({ dir });
  return { path: targetPath, action, fileName: targetName };
}

async function rewriteIndex({ dir }) {
  const entries = await readdir(dir).catch(() => []);
  /** @type {Record<string, string[]>} */
  const sections = { user: [], feedback: [], project: [], reference: [] };
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    if (entry.toUpperCase() === "MEMORY.MD") continue;
    const fullPath = path.join(dir, entry);
    const raw = await readFile(fullPath, "utf8").catch(() => null);
    if (raw == null) continue;
    const parsed = parseMemoryFile(raw);
    const bucket = sections[parsed.type] ?? sections.reference;
    const title = parsed.name || entry.replace(/\.md$/i, "");
    const description = parsed.description || "";
    bucket.push(`- [${title}](${entry})${description ? ` — ${description}` : ""}`);
  }
  for (const key of Object.keys(sections)) sections[key].sort();
  const lines = ["# Memory Index", ""];
  for (const heading of ["user", "feedback", "project", "reference"]) {
    if (sections[heading].length === 0) continue;
    lines.push(`## ${capitalize(heading)}`);
    lines.push(...sections[heading]);
    lines.push("");
  }
  await writeFile(path.join(dir, "MEMORY.md"), `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function deriveFileName({ name, type }) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  const prefix = type && typeof type === "string" ? type : "memory";
  return `${prefix}_${slug || "untitled"}.md`;
}

function countTypes(memories) {
  const counts = { user: 0, feedback: 0, project: 0, reference: 0 };
  for (const memory of memories) {
    if (counts[memory.type] != null) counts[memory.type] += 1;
  }
  return counts;
}

function capitalize(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return value[0].toUpperCase() + value.slice(1);
}
