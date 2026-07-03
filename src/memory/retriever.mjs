import { loadMemoryIndex } from "./store.mjs";

const TOP_N_DEFAULT = 12;

/**
 * Pick the memories most likely to be relevant to the upcoming session and
 * format them for inclusion in the system prompt.
 *
 * Strategy:
 *   - All `user` and `feedback` memories are always included (lifestyle /
 *     guard-rails guidance is rarely irrelevant).
 *   - `project` and `reference` memories are scored by token overlap with
 *     the cwd path and recent prompt text; the top N survive the filter.
 */
export async function retrieveRelevantMemory({ homeDir, cwd = "", topN = TOP_N_DEFAULT, signals = [] } = {}) {
  const index = await loadMemoryIndex({ homeDir });
  if (!index) return null;
  const tokens = collectTokens([cwd, ...signals]);
  const scored = index.memories.map((memory) => ({
    ...memory,
    score: scoreMemory({ memory, tokens })
  }));

  const alwaysInclude = scored.filter((entry) => entry.type === "user" || entry.type === "feedback");
  const ranked = scored
    .filter((entry) => entry.type !== "user" && entry.type !== "feedback")
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return {
    dir: index.dir,
    indexContent: index.indexContent,
    types: index.types,
    selected: [...alwaysInclude, ...ranked]
  };
}

export function formatMemoryForPrompt(snapshot) {
  if (!snapshot) return "";
  const { selected } = snapshot;
  if (!Array.isArray(selected) || selected.length === 0) return "";
  const sections = [];
  for (const heading of ["user", "feedback", "project", "reference"]) {
    const items = selected.filter((entry) => entry.type === heading);
    if (items.length === 0) continue;
    const formatted = items
      .map((entry) => `- ${entry.name}: ${entry.description || "(no description)"}\n  ${truncate(entry.body, 600).replace(/\n/g, "\n  ")}`)
      .join("\n");
    sections.push(`### ${capitalize(heading)}\n${formatted}`);
  }
  return sections.length === 0 ? "" : `## Memory\n${sections.join("\n\n")}`;
}

function collectTokens(values) {
  const tokens = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const word of value.toLowerCase().split(/[^a-z0-9_-]+/)) {
      if (word.length >= 3) tokens.add(word);
    }
  }
  return tokens;
}

function scoreMemory({ memory, tokens }) {
  if (tokens.size === 0) return 0;
  const haystack = `${memory.name} ${memory.description} ${memory.body}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function truncate(value, maxLength) {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function capitalize(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return value[0].toUpperCase() + value.slice(1);
}
