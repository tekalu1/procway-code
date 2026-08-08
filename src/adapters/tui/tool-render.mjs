import { style, stripAnsi } from "./ansi.mjs";
import { sanitizeInline, sanitizeTerminalText } from "./sanitize.mjs";

/**
 * Render a tool call as a "marker + call signature + clipped body" block.
 *
 * Phase 1 makes this the ONLY tool renderer in the TUI: both the live feed
 * (adapters/tui/timeline-renderer.mjs, which used to print a bare
 * `● read file` with no arguments) and the replayed transcript
 * (adapters/tui/transcript-node-render.mjs, which used to dump the raw tool
 * JSON) call it. Live is simply the `result: null` case, so the two surfaces
 * agree on the header glyph, the tool name and the argument summary.
 *
 *   ● run_shell(command="pnpm test")          <- live, call started
 *   ✓ run_shell(command="pnpm test")          <- live, call finished
 *   ✓ run_shell(command="pnpm test")          <- replay, with the result body
 *     Ran: pnpm test (exit 0)
 *     Test Files  137 passed
 *     … (312 more lines)
 *
 * The renderer is deliberately a pure function: callers own the
 * `process.stdout.write` boundary so the streaming write path stays
 * single-pathed (Phase 5 §4 — avoid hotfix 294f143's race).
 */

/**
 * Body clipping defaults. These are the answer to "a `read_file` on a 4k-line
 * file used to be printed as one 53 KB JSON line".
 *
 * - PREVIEW_LINES = 6: at most six body lines per tool call, so four tool
 *   calls still fit on a 24-row terminal without scrolling the assistant's
 *   prose away.
 * - MAX_CHARS = 1200: a hard byte cap applied AFTER the line clip, so a single
 *   pathological line (minified JSON, a one-line generated file) cannot blow
 *   up the terminal. 1200 ≈ 15 wrapped lines at 80 columns.
 */
export const TOOL_PREVIEW_LINES = 6;
export const TOOL_RESULT_MAX_CHARS = 1200;

const MARKERS = {
  start: { glyph: "●", palette: "accentStrong" },
  ok: { glyph: "✓", palette: "success" },
  error: { glyph: "✗", palette: "danger" }
};

export function renderToolCall({
  name,
  args = {},
  result = null,
  ok = true,
  status,
  expanded = false,
  previewLines = TOOL_PREVIEW_LINES,
  maxChars = TOOL_RESULT_MAX_CHARS,
  colorize = true
} = {}) {
  const resolvedName = name ?? result?.kind ?? "tool";
  const resolvedStatus = normaliseStatus({ status, ok, result });
  const headerLine = renderHeader({ name: resolvedName, args, status: resolvedStatus, colorize });
  if (!result) return `${headerLine}\n`;
  // P3e-3. THE widest injection surface in the program: this body is a
  // `read_file` of an attacker-controlled repository, a `run_shell` stdout, a
  // fetched web page or an MCP tool's reply. Sanitise before clipping, so the
  // `maxChars` cut is measured on what is actually shown and can never leave a
  // half-written sequence behind.
  const summaryText = sanitizeTerminalText(formatResult({ name: resolvedName, result }));
  if (!summaryText) return `${headerLine}\n`;
  const { body, hiddenLines, clipped } = clipBody(summaryText, { previewLines, maxChars, expanded });
  const indented = body.length > 0 ? body.split("\n").map((line) => `  ${line}`) : [];
  const trailer = hiddenLines > 0
    ? `… (${hiddenLines} more line${hiddenLines === 1 ? "" : "s"})`
    : clipped ? "… (truncated)" : null;
  if (trailer) {
    indented.push(`  ${colorize ? style("muted", trailer) : trailer}`);
  }
  if (indented.length === 0) return `${headerLine}\n`;
  return `${headerLine}\n${indented.join("\n")}\n`;
}

/**
 * `name(arg=…)` with no colour — the plain-text form of the header used by
 * tests and by callers that need a one-line label. Tools called without
 * arguments render as a bare name (no empty `()`), because the live feed
 * only learns the arguments from `tool.call.scheduled` and would otherwise
 * print `read_file()` for approval-replay calls.
 */
export function summariseToolHeader({ name, args }) {
  const label = sanitizeInline(name);
  const argText = sanitizeInline(formatArgs(name, args ?? {}));
  return argText.length > 0 ? `${label}(${argText})` : `${label}`;
}

function normaliseStatus({ status, ok, result }) {
  if (status === "start" || status === "ok" || status === "error") return status;
  if (ok === false) return "error";
  if (ok === true || result) return "ok";
  return "start";
}

function renderHeader({ name, args, status, colorize }) {
  const marker = MARKERS[status] ?? MARKERS.ok;
  // `path=…` and `dir=…` interpolate a file path straight in (the other
  // formatters go through JSON.stringify, which escapes controls itself), and
  // a file name on Linux may contain any byte but `/` and NUL — so cloning a
  // repository with an `ESC`-bearing name is enough to reach here. This header
  // is also what the approval prompt shows above the y/n question.
  const safeName = sanitizeInline(name);
  const argText = sanitizeInline(formatArgs(name, args ?? {}));
  if (!colorize) {
    return argText.length > 0 ? `${marker.glyph} ${safeName}(${argText})` : `${marker.glyph} ${safeName}`;
  }
  const glyph = style(marker.palette, marker.glyph);
  const label = style(["accent", "bold"], safeName);
  const tail = argText.length > 0 ? style("muted", `(${argText})`) : "";
  return `${glyph} ${label}${tail}`;
}

/**
 * Clip a formatted result body to `previewLines` lines, then to `maxChars`
 * characters, and report how many source lines ended up hidden so the caller
 * can print an accurate `… (N more lines)` trailer.
 */
function clipBody(text, { previewLines, maxChars, expanded }) {
  const allLines = String(text).replace(/\s+$/, "").split("\n");
  const limit = expanded ? allLines.length : Math.max(0, previewLines);
  let body = allLines.slice(0, limit).join("\n");
  const full = allLines.join("\n");
  if (maxChars != null && Number.isFinite(maxChars) && body.length > maxChars) {
    body = body.slice(0, Math.max(0, maxChars));
  }
  const shownLines = body.length === 0 ? 0 : body.split("\n").length;
  return {
    body,
    hiddenLines: Math.max(0, allLines.length - shownLines),
    clipped: body.length < full.length
  };
}

function formatArgs(name, args) {
  if (args == null || typeof args !== "object") return "";
  if (name === "read_file" || name === "Edit" || name === "write_file") {
    return `path=${args.filePath ?? args.path ?? ""}`;
  }
  if (name === "list_files") return `dir=${args.dirPath ?? "."}`;
  if (name === "search_files") return `query=${JSON.stringify(args.query ?? "")}`;
  if (name === "Glob") return `pattern=${JSON.stringify(args.pattern ?? "")}`;
  if (name === "Grep") return `pattern=${JSON.stringify(args.pattern ?? "")}`;
  if (name === "run_shell") return `command=${JSON.stringify(truncate(args.command ?? "", 72))}`;
  if (name === "spawn_agent") return `task=${JSON.stringify(truncate(args.task ?? "", 60))}`;
  if (name === "apply_patch") return "patch=...";
  return Object.keys(args)
    .slice(0, 3)
    .map((key) => `${key}=${shortFormat(args[key])}`)
    .join(", ");
}

function formatResult({ name, result }) {
  if (!result) return "";
  if (name === "read_file") {
    const content = result.data?.content ?? "";
    const truncated = result.data?.truncated ? " (truncated)" : "";
    return `${result.summary}${truncated}\n${content}`;
  }
  if (name === "list_files") {
    const entries = Array.isArray(result.data) ? result.data : [];
    return [result.summary, ...entries.map((entry) => `- ${entry.name}${entry.type === "directory" ? "/" : ""}`)].join("\n");
  }
  if (name === "search_files" || name === "Grep") {
    const matches = Array.isArray(result.data?.matches ?? result.data) ? (result.data.matches ?? result.data) : [];
    return [
      result.summary,
      ...matches.map((match) => `${match.path}:${match.line}: ${match.text ?? ""}`)
    ].join("\n");
  }
  if (name === "Glob") {
    const items = Array.isArray(result.data?.matches) ? result.data.matches : Array.isArray(result.data) ? result.data : [];
    return [result.summary, ...items.map((entry) => (typeof entry === "string" ? entry : entry.path ?? ""))].join("\n");
  }
  if (name === "run_shell") {
    const data = result.data ?? {};
    const segments = [result.summary];
    if (typeof data.stdout === "string" && data.stdout.length > 0) segments.push(data.stdout.trimEnd());
    if (typeof data.stderr === "string" && data.stderr.length > 0) segments.push(`(stderr) ${data.stderr.trimEnd()}`);
    return segments.join("\n");
  }
  if (name === "write_file" || name === "Edit" || name === "apply_patch") {
    return result.summary;
  }
  if (name === "spawn_agent") {
    const text = result.data?.text ?? "";
    return text ? `${result.summary}\n${text}` : result.summary;
  }
  if (typeof result.summary === "string" && result.summary.length > 0) return result.summary;
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function shortFormat(value) {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(truncate(value, 30));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value).slice(0, 30);
}

function truncate(text, max) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function plainText(rendered) {
  return stripAnsi(rendered);
}
