import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { compileGlob } from "./glob.mjs";

const DEFAULT_IGNORES = new Set([".git", "node_modules", ".playwright-cli", "coverage", "dist", "build", ".next", ".cache", ".pnpm-store", ".nuxt", ".output", ".vite", "temporary", "test-results"]);

const ripgrepAvailability = new WeakMap();

// Hard ceiling so a hung ripgrep child can never block a turn forever. Layered
// on top of the stdin-ignore + `.` path arg fix: those address the documented
// rg-reads-from-stdin deadlock, but a child can still wedge for other reasons
// (e.g. a piped stderr we drain too slowly). The scheduler now has a per-tool
// timeout too, but keeping a local ceiling means the rg child gets SIGKILLed
// instead of being left as a zombie when the scheduler bails.
const RIPGREP_TIMEOUT_MS = 30_000;

/**
 * Workspace regex search. Mirrors `Glob` but matches file CONTENTS instead
 * of file names. ripgrep is the primary engine (fast, `.gitignore`-aware);
 * the JS fallback uses RegExp + a directory walk identical in shape to
 * `Glob`'s fallback.
 */
export async function runGrep({
  pattern,
  cwd = process.cwd(),
  dirPath = ".",
  glob = null,
  maxResults = 200,
  contextLines = 0,
  caseInsensitive = false,
  respectGitignore = true,
  spawnImpl = spawn
} = {}) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new TypeError("Grep: pattern is required");
  }
  const root = path.resolve(cwd, dirPath);
  const useRipgrep = await canUseRipgrep(spawnImpl);
  const matches = useRipgrep
    ? await ripgrepSearch({ pattern, cwd: root, glob, maxResults, contextLines, caseInsensitive, respectGitignore, spawnImpl })
    : await jsSearch({ pattern, cwd: root, glob, maxResults, contextLines, caseInsensitive, respectGitignore });
  const truncated = matches.length >= maxResults;
  return {
    kind: "search_files",
    summary: `Found ${matches.length}${truncated ? "+" : ""} match(es) for /${pattern}/ in ${shortPath(root, cwd)}`,
    data: { matches, pattern, dirPath, glob, truncated, ripgrep: useRipgrep }
  };
}

async function canUseRipgrep(spawnImpl) {
  const cached = ripgrepAvailability.get(spawnImpl);
  if (cached !== undefined) return cached;
  const probe = new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      const child = spawnImpl("rg", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        finish(false);
      }, 2_000);
      child.on("error", () => finish(false));
      child.on("exit", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
  ripgrepAvailability.set(spawnImpl, probe);
  return probe;
}

async function ripgrepSearch({ pattern, cwd, glob, maxResults, contextLines, caseInsensitive, respectGitignore, spawnImpl }) {
  return new Promise((resolve) => {
    const args = ["--no-heading", "--with-filename", "--line-number", "--color", "never", "-m", String(maxResults)];
    if (caseInsensitive) args.push("--ignore-case");
    if (contextLines > 0) args.push(`-C${contextLines}`);
    if (glob) args.push("--glob", glob);
    if (!respectGitignore) args.push("--no-ignore");
    args.push(pattern, ".");
    const child = spawnImpl("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let newlineCount = 0;
    let errored = false;
    let killed = false;
    let settled = false;
    let timer;
    const finishWithChunks = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (errored) return resolve([]);
      const output = Buffer.concat(chunks).toString("utf8");
      resolve(parseRipgrepOutput(output, cwd).slice(0, maxResults));
    };
    child.stdout?.on("data", (chunk) => {
      if (killed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 0x0a) newlineCount += 1;
      }
      if (newlineCount >= maxResults) {
        killed = true;
        try { child.kill(); } catch { /* already gone */ }
      }
    });
    // Drain stderr unconditionally. Without this listener Node leaves the
    // stderr pipe filling up; once it hits the OS buffer (~64 KB on Linux)
    // ripgrep blocks on its next write and can wedge — a second pathway to
    // the TK-15 hang separate from the stdin block fixed by `stdio:
    // ['ignore', ...]` above. We don't need the bytes, so just discard them.
    child.stderr?.on("data", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.on("error", () => { errored = true; finishWithChunks(); });
    // Listen for both 'exit' (process ended) and 'close' (stdio drained).
    // Real spawns fire both; mock EventEmitters in tests typically emit
    // only one. The settled guard inside finishWithChunks prevents
    // double-resolution. 'close' is preferred when available because it
    // arrives after stdout buffers have been fully read; 'exit' is the
    // fallback so we still settle if 'close' is never emitted (signal
    // delivery quirks, killed children that left a pipe in flight, etc.).
    child.on("exit", finishWithChunks);
    child.on("close", finishWithChunks);
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finishWithChunks();
    }, RIPGREP_TIMEOUT_MS);
  });
}

function parseRipgrepOutput(output, cwd) {
  const matches = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    const rel = match[1].startsWith("./") ? match[1].slice(2) : match[1];
    matches.push({
      path: path.resolve(cwd, rel),
      relPath: rel,
      line: Number(match[2]),
      text: match[3]
    });
  }
  return matches;
}

async function jsSearch({ pattern, cwd, glob, maxResults, contextLines: _contextLines, caseInsensitive, respectGitignore }) {
  const re = compileRegex(pattern, { caseInsensitive });
  const fileMatcher = glob ? compileGlob(glob) : () => true;
  const ignores = new Set(DEFAULT_IGNORES);
  if (respectGitignore) {
    const gitignore = await readGitignoreEntries(cwd);
    for (const entry of gitignore) ignores.add(entry);
  }
  const matches = [];
  await walk(cwd, "", re, fileMatcher, ignores, matches, maxResults);
  return matches;
}

function compileRegex(pattern, { caseInsensitive }) {
  const flags = caseInsensitive ? "i" : "";
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new TypeError(`Grep: invalid regex /${pattern}/: ${error.message}`, { cause: error });
  }
}

async function walk(root, rel, re, fileMatcher, ignores, results, max) {
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
      await walk(root, childRel, re, fileMatcher, ignores, results, max);
    } else if (entry.isFile()) {
      if (!fileMatcher(childRel) && !fileMatcher(entry.name)) {
        continue;
      }
      const filePath = path.join(root, childRel);
      let content;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (results.length >= max) return;
        if (re.test(lines[lineIndex])) {
          results.push({
            path: filePath,
            relPath: childRel,
            line: lineIndex + 1,
            text: lines[lineIndex].slice(0, 300)
          });
        }
      }
    }
  }
}

async function readGitignoreEntries(cwd) {
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

function shortPath(absolutePath, cwd) {
  const root = path.resolve(cwd);
  if (absolutePath === root) return ".";
  if (absolutePath.startsWith(`${root}${path.sep}`)) {
    return absolutePath.slice(root.length + 1);
  }
  return absolutePath;
}
