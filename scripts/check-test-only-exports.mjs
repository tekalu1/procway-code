#!/usr/bin/env node
/**
 * Report exports under `src/` that nothing in `src/` ever references, and
 * that only the test suite imports (P4-4).
 *
 * The motivating bug: `renderToolCall` sat in `src/adapters/tui/` exported,
 * covered by its own passing unit test, and never called by the program. The
 * suite was green and the feature did not exist. That shape — "no runtime
 * caller, one test file" — is what this script looks for.
 *
 * It is deliberately ADVISORY, not a gate. Exporting an internal helper so a
 * unit test can reach it is a legitimate, widely used seam here (about a
 * hundred exports are only *imported* by tests), so failing the build on the
 * pattern would be wrong. What is reported is the narrower case: the symbol
 * is not referenced anywhere in `src/` at all, not even inside the file that
 * declares it. That list is short enough to read in a CI log.
 *
 *   node scripts/check-test-only-exports.mjs            report, exit 0
 *   node scripts/check-test-only-exports.mjs --check    exit 1 if the list grew
 *
 * Matching is textual (no parser, no dependency): a symbol counts as
 * referenced if its name appears as a whole word anywhere else. That
 * over-counts rather than under-counts, so a name in this report really is
 * unused — but a name missing from it is not proof of the opposite.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The count on the day this script was written. `--check` fails when the
 * list grows past it: a new entry means somebody added an export with no
 * caller, which is either dead code or a feature that was never wired up.
 * Lower it whenever the list shrinks.
 */
const BASELINE = 22;

/**
 * Files whose exports are the published API (`package.json` `exports`), so
 * "no caller inside this repo" is expected and says nothing.
 */
function isPublicApi(file) {
  return file.includes(`${path.sep}src${path.sep}core${path.sep}`)
    || file.endsWith(`${path.sep}src${path.sep}cli.mjs`)
    || file.endsWith(`${path.sep}src${path.sep}jobs${path.sep}delegated-jobs.mjs`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const DECLARED = /^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const RE_EXPORTED = /^export\s*\{([^}]*)\}/gm;

function collectExports(file, text) {
  const names = new Set();
  for (const match of text.matchAll(DECLARED)) names.add(match[1]);
  for (const match of text.matchAll(RE_EXPORTED)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && name !== "default") names.add(name);
    }
  }
  return [...names].map((name) => ({ file, name }));
}

/** Occurrences of `name` as a whole word, minus the export statement itself. */
function referencesIn(text, name, isDeclaringFile) {
  const total = (text.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
  if (!isDeclaringFile) return total;
  let declarations = 0;
  if (new RegExp(`^export\\s+(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+${name}\\b`, "m").test(text)) declarations += 1;
  if (new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "m").test(text)) declarations += 1;
  return Math.max(0, total - declarations);
}

const srcFiles = walk(path.join(ROOT, "src"));
const testFiles = walk(path.join(ROOT, "tests"));
const sources = new Map([...srcFiles, ...testFiles].map((file) => [file, readFileSync(file, "utf8")]));

const findings = [];
for (const file of srcFiles) {
  if (isPublicApi(file)) continue;
  for (const { name } of collectExports(file, sources.get(file))) {
    let runtimeRefs = 0;
    for (const other of srcFiles) {
      runtimeRefs += referencesIn(sources.get(other), name, other === file);
      if (runtimeRefs > 0) break;
    }
    if (runtimeRefs > 0) continue;
    const testers = testFiles.filter((test) => new RegExp(`\\b${name}\\b`).test(sources.get(test)));
    if (testers.length === 0) continue;
    findings.push({
      file: path.relative(ROOT, file),
      name,
      testers: testers.map((test) => path.relative(ROOT, test))
    });
  }
}

findings.sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file)));

const label = `${findings.length} export${findings.length === 1 ? "" : "s"} under src/ with no runtime caller, referenced only by tests`;
console.log(label);
console.log("-".repeat(label.length));
for (const finding of findings) {
  console.log(`${finding.file}: ${finding.name}`);
  for (const tester of finding.testers) console.log(`    used by ${tester}`);
}

if (process.argv.includes("--check") && findings.length > BASELINE) {
  console.error(
    `\nFAIL: ${findings.length} > baseline ${BASELINE}.\n`
    + "A new export with no runtime caller is either dead code or a feature that\n"
    + "was written and never wired up. Call it, delete it, or — if it really is a\n"
    + "test-only seam — raise BASELINE in scripts/check-test-only-exports.mjs and\n"
    + "say why in the commit message."
  );
  process.exitCode = 1;
}
