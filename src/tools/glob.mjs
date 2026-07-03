import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_IGNORES = [".git", "node_modules", ".playwright-cli", "coverage", "dist", "build", ".next", ".cache", ".pnpm-store", ".nuxt", ".output", ".vite", "temporary", "test-results"];

const ripgrepAvailability = new WeakMap();

/**
 * Workspace glob search. Tries `rg --files -g <pattern>` first (it honours
 * `.gitignore` for free); falls back to a JS walker that mirrors the same
 * shape so the returned `ToolResult` is identical.
 *
 * Phase 5 §2.9: no new runtime dependency was added — the JS fallback uses
 * `fs.readdir` and a hand-rolled glob → regex compiler. ripgrep is invoked
 * via child_process.spawn when available (`PATH` lookup) and gracefully
 * degrades if the binary is missing.
 */
export async function runGlob({
  pattern,
  cwd = process.cwd(),
  dirPath = ".",
  maxResults = 1000,
  respectGitignore = true,
  spawnImpl = spawn
} = {}) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new TypeError("Glob: pattern is required");
  }
  const root = path.resolve(cwd, dirPath);
  const useRipgrep = await canUseRipgrep(spawnImpl);
  const matches = useRipgrep
    ? await ripgrepGlob({ pattern, cwd: root, maxResults, respectGitignore, spawnImpl })
    : await jsGlob({ pattern, cwd: root, maxResults, respectGitignore });
  const truncated = matches.length >= maxResults;
  return {
    kind: "search_files",
    summary: `Found ${matches.length}${truncated ? "+" : ""} match(es) for "${pattern}" in ${shortPath(root, cwd)}`,
    data: { matches, pattern, dirPath, truncated, ripgrep: useRipgrep }
  };
}

async function canUseRipgrep(spawnImpl) {
  const cached = ripgrepAvailability.get(spawnImpl);
  if (cached !== undefined) return cached;
  const probe = new Promise((resolve) => {
    try {
      const child = spawnImpl("rg", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  ripgrepAvailability.set(spawnImpl, probe);
  return probe;
}

async function ripgrepGlob({ pattern, cwd, maxResults, respectGitignore, spawnImpl }) {
  return new Promise((resolve) => {
    const args = ["--files", "-g", pattern];
    if (!respectGitignore) args.push("--no-ignore");
    const child = spawnImpl("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let errored = false;
    child.stdout?.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", () => { errored = true; resolve([]); });
    child.on("exit", () => {
      if (errored) return;
      const output = Buffer.concat(chunks).toString("utf8");
      const results = output.split(/\r?\n/).filter(Boolean).slice(0, maxResults).map((file) => ({
        path: path.resolve(cwd, file),
        relPath: file
      }));
      resolve(results);
    });
  });
}

async function jsGlob({ pattern, cwd, maxResults, respectGitignore }) {
  const matcher = compileGlob(pattern);
  const ignores = new Set(DEFAULT_IGNORES);
  if (respectGitignore) {
    const gitignore = await readGitignore(cwd);
    for (const entry of gitignore) ignores.add(entry);
  }
  const matches = [];
  await walk(cwd, "", matcher, ignores, matches, maxResults);
  return matches;
}

async function walk(root, rel, matcher, ignores, results, max) {
  if (results.length >= max) return;
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= max) return;
    if (ignores.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, childRel, matcher, ignores, results, max);
    } else if (entry.isFile()) {
      if (matcher(childRel)) {
        results.push({ path: path.join(root, childRel), relPath: childRel });
      }
    }
  }
}

async function readGitignore(cwd) {
  try {
    const text = await readFile(path.join(cwd, ".gitignore"), "utf8");
    const entries = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
      let normalized = line;
      if (normalized.startsWith("**/")) normalized = normalized.slice(3);
      if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
      if (normalized.length === 0) continue;
      if (normalized.includes("/") || normalized.includes("*")) continue;
      entries.push(normalized);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Compile a glob pattern into a `(path) => boolean` matcher. Supports `*`,
 * `**`, `?`, `[abc]`, and `{a,b}` (alternation) — the subset we actually
 * use in tests and tool calls.
 */
export function compileGlob(pattern) {
  const re = new RegExp(`^${globToRegex(pattern)}$`);
  return (input) => re.test(input);
}

function globToRegex(pattern) {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end > i) {
        out += pattern.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end > i) {
        const alts = pattern.slice(i + 1, end).split(",");
        out += `(?:${alts.map((alt) => globToRegex(alt)).join("|")})`;
        i = end + 1;
        continue;
      }
    }
    if (/[\\^$.+()|]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
}

function shortPath(absolutePath, cwd) {
  const root = path.resolve(cwd);
  if (absolutePath === root) return ".";
  if (absolutePath.startsWith(`${root}${path.sep}`)) {
    return absolutePath.slice(root.length + 1);
  }
  return absolutePath;
}

// Reserved for future stat-based filters (size, modification time).
export async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
