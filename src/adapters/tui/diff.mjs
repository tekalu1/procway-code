import { color, dim, bold } from "./ansi.mjs";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.mjs";

/**
 * Render a unified diff preview for write-style approvals (`write_file`,
 * `apply_patch`, `Edit`). Used by the approval prompt before asking the user
 * to accept the change.
 *
 * Phase 3a rewrite (P3a-5): the output now follows the `diff -u` / `git diff`
 * conventions every reviewer already knows —
 *
 *   - removals are printed before additions inside a change run,
 *   - only the changed regions are shown, each introduced by an
 *     `@@ -old,count +new,count @@` hunk header,
 *   - positions live in the hunk header instead of a per-line number column,
 *     so there is exactly one numbering convention on screen.
 *
 * The line matcher is still a plain LCS. It is guarded on two sides: common
 * head/tail lines are trimmed before the table is built (the usual edit-a-few-
 * lines-in-a-big-file case collapses to a tiny problem), and anything still
 * bigger than `MAX_DIFF_CELLS` degrades to a whole-region replacement with a
 * note rather than allocating an O(N*M) table. A real Myers implementation is
 * deliberately out of scope.
 */

const DEFAULT_CONTEXT = 3;

/** Upper bound on the LCS table after common head/tail trimming. */
export const MAX_DIFF_CELLS = 1_000_000;

/** Hard cap on the input itself, so even the trimming pass stays cheap. */
export const MAX_DIFF_LINES = 50_000;

export function renderDiff({
  filePath,
  before = "",
  after = "",
  operation = inferOperation({ before, after }),
  maxLines = 40,
  context = DEFAULT_CONTEXT,
  colorize = true
} = {}) {
  const banner = renderBanner({ filePath, operation, colorize });
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  if (operation === "create") {
    const body = [
      hunkHeader({ oldStart: 0, oldCount: 0, newStart: afterLines.length ? 1 : 0, newCount: afterLines.length }, colorize),
      ...afterLines.map((line) => addLine(line, colorize))
    ];
    return [banner, ...renderTruncated(body, maxLines, colorize)].join("\n") + "\n";
  }
  if (operation === "delete") {
    const body = [
      hunkHeader({ oldStart: beforeLines.length ? 1 : 0, oldCount: beforeLines.length, newStart: 0, newCount: 0 }, colorize),
      ...beforeLines.map((line) => removeLine(line, colorize))
    ];
    return [banner, ...renderTruncated(body, maxLines, colorize)].join("\n") + "\n";
  }

  const { ops, degraded } = diffOps(beforeLines, afterLines);
  const hunks = buildHunks(ops, context);
  const body = [];
  if (degraded) {
    const note = `... (diff too large for line matching — showing a full replacement)`;
    body.push(colorize ? dim(note) : note);
  }
  if (hunks.length === 0) {
    const note = "(no changes)";
    body.push(colorize ? dim(note) : note);
  }
  for (const hunk of hunks) {
    body.push(hunkHeader(hunkRange(hunk), colorize));
    for (const op of hunk) {
      if (op.type === "context") body.push(contextLine(op.text, colorize));
      else if (op.type === "remove") body.push(removeLine(op.text, colorize));
      else body.push(addLine(op.text, colorize));
    }
  }
  return [banner, ...renderTruncated(body, maxLines, colorize)].join("\n") + "\n";
}

/**
 * P3e-4. This is the text the user reads immediately before answering `y` to
 * "may I write this file?", so it is the single highest-value target in the
 * program: a cursor-positioning sequence in the "after" side could repaint the
 * banner and the tool header above it, and the user would approve a write they
 * never saw. Sanitising happens on the way IN, before the LCS runs, so both
 * sides are compared in the same (safe) representation and the `+`/`-` prefixes
 * we add are always the first thing on their row.
 */
function splitLines(value) {
  const text = sanitizeTerminalText(value);
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function renderBanner({ filePath, operation, colorize }) {
  const verb = operation === "create" ? "+ Created"
    : operation === "delete" ? "- Deleted"
    : operation === "modify" ? "~ Modified"
    : "= Diff";
  const label = colorize
    ? bold(operation === "create" ? color("green", verb) : operation === "delete" ? color("red", verb) : color("yellow", verb))
    : verb;
  // The path is model-chosen; keep it on one row so it cannot push the hunk
  // headers off screen, and neutralise it like the body.
  return `${label}: ${sanitizeInline(filePath)}`;
}

function renderTruncated(lines, maxLines, colorize) {
  if (!Number.isFinite(maxLines) || lines.length <= maxLines) return lines;
  const head = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  const trailer = `... (${remaining} more lines, show more for full diff)`;
  return [...head, colorize ? dim(trailer) : trailer];
}

function inferOperation({ before, after }) {
  if (before == null || before === "") {
    return after == null || after === "" ? "modify" : "create";
  }
  if (after == null || after === "") return "delete";
  return "modify";
}

function hunkHeader({ oldStart, oldCount, newStart, newCount }, colorize) {
  const text = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  return colorize ? color("cyan", text) : text;
}

function hunkRange(hunk) {
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;
  for (const op of hunk) {
    if (op.type !== "add") {
      if (oldCount === 0) oldStart = op.beforeLine;
      oldCount += 1;
    }
    if (op.type !== "remove") {
      if (newCount === 0) newStart = op.afterLine;
      newCount += 1;
    }
  }
  return { oldStart: oldCount === 0 ? 0 : oldStart, oldCount, newStart: newCount === 0 ? 0 : newStart, newCount };
}

function addLine(text, colorize) {
  const body = `+${text}`;
  return colorize ? color("green", body) : body;
}

function removeLine(text, colorize) {
  const body = `-${text}`;
  return colorize ? color("red", body) : body;
}

function contextLine(text, colorize) {
  const body = ` ${text}`;
  return colorize ? dim(body) : body;
}

/**
 * Group the op stream into unified-diff hunks: every change plus `context`
 * lines around it. Runs separated by more than `2 * context` unchanged lines
 * become separate hunks, matching `diff -u`.
 */
export function buildHunks(ops, context = DEFAULT_CONTEXT) {
  const hunks = [];
  const changed = ops.map((op) => op.type !== "context");
  let index = 0;
  while (index < ops.length) {
    if (!changed[index]) {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    let cursor = index;
    while (cursor < ops.length) {
      if (changed[cursor]) {
        end = cursor;
        cursor += 1;
        continue;
      }
      let run = cursor;
      while (run < ops.length && !changed[run]) run += 1;
      // A short unchanged run stays inside the hunk; a long one closes it.
      if (run < ops.length && run - cursor <= context * 2) {
        cursor = run;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, end + context + 1);
    hunks.push(orderRemovesFirst(ops.slice(start, stop)));
    index = stop;
  }
  return hunks;
}

/**
 * Unified diff prints every removal of a change run before its additions. The
 * LCS backtrack can emit them interleaved, so normalise here (stable within
 * each kind, which keeps the original line order inside the run).
 */
function orderRemovesFirst(ops) {
  const out = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === "context") {
      out.push(ops[index]);
      index += 1;
      continue;
    }
    const run = [];
    while (index < ops.length && ops[index].type !== "context") {
      run.push(ops[index]);
      index += 1;
    }
    out.push(...run.filter((op) => op.type === "remove"), ...run.filter((op) => op.type === "add"));
  }
  return out;
}

/**
 * Line diff with head/tail trimming and a size guard.
 * Returns `{ ops, degraded }` where each op is
 * `{ type, text, beforeLine, afterLine }` (1-based; `null` when the line does
 * not exist on that side).
 */
export function diffOps(before, after) {
  const beforeLines = Array.isArray(before) ? before : splitLines(before);
  const afterLines = Array.isArray(after) ? after : splitLines(after);

  let head = 0;
  const maxHead = Math.min(beforeLines.length, afterLines.length);
  while (head < maxHead && beforeLines[head] === afterLines[head]) head += 1;
  let tail = 0;
  while (
    tail < maxHead - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midBefore = beforeLines.slice(head, beforeLines.length - tail);
  const midAfter = afterLines.slice(head, afterLines.length - tail);

  const tooLarge =
    midBefore.length > MAX_DIFF_LINES ||
    midAfter.length > MAX_DIFF_LINES ||
    (midBefore.length + 1) * (midAfter.length + 1) > MAX_DIFF_CELLS;

  const middle = tooLarge
    ? [
        ...midBefore.map((text, idx) => ({ type: "remove", text, offsetBefore: idx, offsetAfter: null })),
        ...midAfter.map((text, idx) => ({ type: "add", text, offsetBefore: null, offsetAfter: idx }))
      ]
    : lcsOps(midBefore, midAfter);

  const ops = [];
  for (let idx = 0; idx < head; idx += 1) {
    ops.push({ type: "context", text: beforeLines[idx], beforeLine: idx + 1, afterLine: idx + 1 });
  }
  for (const op of middle) {
    ops.push({
      type: op.type,
      text: op.text,
      beforeLine: op.offsetBefore == null ? null : head + op.offsetBefore + 1,
      afterLine: op.offsetAfter == null ? null : head + op.offsetAfter + 1
    });
  }
  for (let idx = 0; idx < tail; idx += 1) {
    const beforeIndex = beforeLines.length - tail + idx;
    const afterIndex = afterLines.length - tail + idx;
    ops.push({
      type: "context",
      text: beforeLines[beforeIndex],
      beforeLine: beforeIndex + 1,
      afterLine: afterIndex + 1
    });
  }
  return { ops: orderRemovesFirst(ops), degraded: tooLarge };
}

/** Backwards-compatible helper: the op list without the guard metadata. */
export function diffLines(before, after) {
  return diffOps(before, after).ops;
}

/**
 * Classic LCS backtrack over the trimmed region. The table is a flat
 * Int32Array (one allocation, ~4 MB at the `MAX_DIFF_CELLS` ceiling) instead
 * of an array of arrays.
 */
function lcsOps(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Int32Array(rows * cols);
  for (let i = 1; i < rows; i += 1) {
    const rowOffset = i * cols;
    const prevOffset = rowOffset - cols;
    for (let j = 1; j < cols; j += 1) {
      if (a[i - 1] === b[j - 1]) table[rowOffset + j] = table[prevOffset + j - 1] + 1;
      else table[rowOffset + j] = Math.max(table[prevOffset + j], table[rowOffset + j - 1]);
    }
  }
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: "context", text: a[i - 1], offsetBefore: i - 1, offsetAfter: j - 1 });
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * cols + j] >= table[i * cols + j - 1]) {
      ops.push({ type: "remove", text: a[i - 1], offsetBefore: i - 1, offsetAfter: null });
      i -= 1;
    } else {
      ops.push({ type: "add", text: b[j - 1], offsetBefore: null, offsetAfter: j - 1 });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ type: "remove", text: a[i - 1], offsetBefore: i - 1, offsetAfter: null });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ type: "add", text: b[j - 1], offsetBefore: null, offsetAfter: j - 1 });
    j -= 1;
  }
  return ops.reverse();
}
