import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getActiveSkillScanners } from "./scanner-config.mjs";
import { parseFrontmatter } from "../memory/parser.mjs";

export async function scanSkills({ cwd = process.cwd(), settings }) {
  const workspaceDir = path.resolve(cwd);
  const scanners = getActiveSkillScanners(settings);
  const found = [];

  for (const scanner of scanners) {
    for (const root of scanner.roots ?? []) {
      const rootPath = resolveConfiguredPath(root, workspaceDir);
      const files = await findSkillFiles(rootPath, scanner.glob ?? "*/SKILL.md");
      for (const filePath of files) {
        const raw = await readFile(filePath, "utf8");
        const { frontmatter, body } = parseFrontmatter(raw);
        const v2 = isV2Frontmatter(frontmatter);
        const priority = v2 && typeof frontmatter.priority === "number"
          ? frontmatter.priority
          : (scanner.priority ?? 0);
        found.push({
          type: "skill",
          scannerId: scanner.id,
          compatibility: scanner.compatibility ?? "shared",
          priority,
          path: filePath,
          content: raw,
          body,
          frontmatter: v2 ? frontmatter : null,
          name: v2 && typeof frontmatter.name === "string" ? frontmatter.name : path.basename(path.dirname(filePath)),
          description: v2 && typeof frontmatter.description === "string" ? frontmatter.description : "",
          allowedTools: v2 && Array.isArray(frontmatter["allowed-tools"]) ? frontmatter["allowed-tools"] : null,
          scope: v2 && typeof frontmatter.scope === "string" ? frontmatter.scope : null,
          triggers: v2 && Array.isArray(frontmatter.triggers) ? frontmatter.triggers : null,
          version: v2 ? 2 : 1
        });
      }
    }
  }

  return found.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path));
}

function isV2Frontmatter(frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return false;
  return "name" in frontmatter
    || "allowed-tools" in frontmatter
    || "triggers" in frontmatter
    || "scope" in frontmatter
    || "description" in frontmatter;
}

/**
 * Filter v2 skills against a user-supplied query (for dynamic loading).
 * v1 skills (no frontmatter) are always included for back-compat. v2 skills
 * are included only when at least one trigger matches the lowercased query.
 *
 * Pure: no I/O.
 */
export function filterSkillsByTrigger(skills, query, { workspaceDir = process.cwd() } = {}) {
  const haystack = typeof query === "string" ? query.toLowerCase() : "";
  return (skills ?? []).filter((skill) => {
    if (skill?.scope === "this-repo") {
      // "this-repo" skills only apply when the file lives under the active
      // workspace. Anything outside is filtered out regardless of triggers.
      const desired = path.resolve(workspaceDir);
      if (!skill.path.startsWith(desired)) return false;
    }
    if (skill?.version !== 2) return true;
    if (!Array.isArray(skill?.triggers) || skill.triggers.length === 0) return true;
    if (haystack.length === 0) return false;
    return skill.triggers.some((trigger) => typeof trigger === "string" && haystack.includes(trigger.toLowerCase()));
  });
}

export function resolveConfiguredPath(configuredPath, workspaceDir) {
  if (configuredPath === "~") return os.homedir();
  if (configuredPath.startsWith("~/") || configuredPath.startsWith("~\\")) {
    return path.join(os.homedir(), configuredPath.slice(2));
  }
  if (path.isAbsolute(configuredPath)) return configuredPath;
  return path.resolve(workspaceDir, configuredPath);
}

async function findSkillFiles(rootPath, glob) {
  const rootEntries = await safeReaddir(rootPath, { withFileTypes: true });
  if (rootEntries.length === 0) return [];

  if (glob === "*/SKILL.md") {
    const files = [];
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(rootPath, entry.name, "SKILL.md");
      if (await fileReadable(candidate)) files.push(candidate);
    }
    return files;
  }

  if (glob === "**/SKILL.md") {
    return findRecursiveSkillFiles(rootPath);
  }

  if (glob === "SKILL.md") {
    const candidate = path.join(rootPath, "SKILL.md");
    return (await fileReadable(candidate)) ? [candidate] : [];
  }

  throw new Error(`Unsupported skill scanner glob: ${glob}`);
}

async function findRecursiveSkillFiles(dir) {
  const entries = await safeReaddir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findRecursiveSkillFiles(fullPath)));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(fullPath);
    }
  }
  return files;
}

async function safeReaddir(dir, options) {
  try {
    return await readdir(dir, options);
  } catch {
    return [];
  }
}

async function fileReadable(filePath) {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}
