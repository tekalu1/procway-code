import { color, dim, bold } from "./ansi.mjs";

/**
 * Render a unified diff preview for write-style approvals (`write_file`,
 * `apply_patch`, `Edit`). Used by the approval prompt before asking the user
 * to accept the change.
 *
 * The diff is intentionally simple — a line-by-line LCS-style comparison is
 * sufficient for the small change sets our tools produce, and it sidesteps
 * the cost of pulling in a Myers diff dependency. Larger files are summarised
 * with a "show more" trailer so the prompt does not flood the terminal.
 */
export function renderDiff({
  filePath,
  before = "",
  after = "",
  operation = inferOperation({ before, after }),
  maxLines = 40,
  colorize = true
} = {}) {
  const banner = renderBanner({ filePath, operation, colorize });
  if (operation === "create") {
    const lines = String(after).split("\n");
    const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    return [banner, ...renderTruncated(trimmed.map((line, idx) => addLine(idx + 1, line, colorize)), maxLines, colorize)].join("\n") + "\n";
  }
  if (operation === "delete") {
    const lines = String(before).split("\n");
    const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    return [banner, ...renderTruncated(trimmed.map((line, idx) => removeLine(idx + 1, line, colorize)), maxLines, colorize)].join("\n") + "\n";
  }
  const beforeLines = String(before).split("\n");
  const afterLines = String(after).split("\n");
  const ops = diffLines(beforeLines, afterLines);
  const rendered = [];
  for (const op of ops) {
    if (op.type === "context") rendered.push(contextLine(op.lineNumber, op.text, colorize));
    if (op.type === "remove") rendered.push(removeLine(op.lineNumber, op.text, colorize));
    if (op.type === "add") rendered.push(addLine(op.lineNumber, op.text, colorize));
  }
  return [banner, ...renderTruncated(rendered, maxLines, colorize)].join("\n") + "\n";
}

function renderBanner({ filePath, operation, colorize }) {
  const verb = operation === "create" ? "+ Created"
    : operation === "delete" ? "- Deleted"
    : operation === "modify" ? "~ Modified"
    : "= Diff";
  const label = colorize
    ? bold(operation === "create" ? color("green", verb) : operation === "delete" ? color("red", verb) : color("yellow", verb))
    : verb;
  return `${label}: ${filePath}`;
}

function renderTruncated(lines, maxLines, colorize) {
  if (lines.length <= maxLines) return lines;
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

function addLine(number, text, colorize) {
  const body = `+ ${pad(number)}: ${text}`;
  return colorize ? color("green", body) : body;
}

function removeLine(number, text, colorize) {
  const body = `- ${pad(number)}: ${text}`;
  return colorize ? color("red", body) : body;
}

function contextLine(number, text, colorize) {
  const body = `  ${pad(number)}: ${text}`;
  return colorize ? dim(body) : body;
}

function pad(value) {
  return String(value).padStart(4, " ");
}

/**
 * Minimal line LCS — runs in O(N*M) time, fine for the small diffs we produce
 * here. Returns an array of `{ type, text, lineNumber }` operations where
 * `lineNumber` references the resulting file (i.e. the "after" position for
 * context/add and the "before" position for remove).
 */
export function diffLines(before, after) {
  const lcs = computeLcsTable(before, after);
  const ops = [];
  let i = before.length;
  let j = after.length;
  while (i > 0 && j > 0) {
    if (before[i - 1] === after[j - 1]) {
      ops.push({ type: "context", text: before[i - 1], lineNumber: j });
      i -= 1;
      j -= 1;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      ops.push({ type: "remove", text: before[i - 1], lineNumber: i });
      i -= 1;
    } else {
      ops.push({ type: "add", text: after[j - 1], lineNumber: j });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ type: "remove", text: before[i - 1], lineNumber: i });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ type: "add", text: after[j - 1], lineNumber: j });
    j -= 1;
  }
  return ops.reverse();
}

function computeLcsTable(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (a[i - 1] === b[j - 1]) table[i][j] = table[i - 1][j - 1] + 1;
      else table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table;
}
