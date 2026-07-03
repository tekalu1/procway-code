import { color, dim, bold, stripAnsi } from "./ansi.mjs";

/**
 * Render a tool call's lifecycle as a collapsible "header + summary" block,
 * following Phase 5 §2.6 of the brief. The renderer is deliberately a pure
 * function: callers must own the `process.stdout.write` boundary so the
 * streaming write path stays single-pathed (Phase 5 §4 — avoid hotfix
 * 294f143's race).
 *
 * - When `expanded === false`, only the first `previewLines` lines of the
 *   formatted output are shown, with a `... (N more lines, type :show)`
 *   trailer.
 * - The kind-aware formatters (read_file, run_shell, etc.) keep the summary
 *   readable without requiring callers to inspect the structured `data`
 *   themselves.
 */
export function renderToolCall({
  name,
  args = {},
  result = null,
  ok = true,
  expanded = false,
  previewLines = 5,
  colorize = true
} = {}) {
  const headerLine = renderHeader({ name, args, ok, colorize });
  if (!result) return `${headerLine}\n`;
  const summaryText = formatResult({ name, result });
  const lines = summaryText.split("\n");
  const visibleLines = expanded ? lines : lines.slice(0, previewLines);
  const trailer = expanded || lines.length <= previewLines
    ? null
    : `... (${lines.length - previewLines} more lines, type :show to expand)`;
  const indented = visibleLines.map((line) => `  ${line}`);
  if (trailer) {
    indented.push(`  ${colorize ? dim(trailer) : trailer}`);
  }
  return `${headerLine}\n${indented.join("\n")}\n`;
}

export function summariseToolHeader({ name, args }) {
  const argText = formatArgs(name, args ?? {});
  return argText.length > 0 ? `${name}(${argText})` : `${name}()`;
}

function renderHeader({ name, args, ok, colorize }) {
  const label = summariseToolHeader({ name, args });
  const status = ok ? "→" : "✗";
  if (!colorize) return `> tool: ${label} ${status}`;
  const tinted = ok ? color("cyan", label) : color("red", label);
  return `${dim("> tool:")} ${bold(tinted)} ${ok ? color("green", status) : color("red", status)}`;
}

function formatArgs(name, args) {
  if (name === "read_file" || name === "Edit" || name === "write_file") {
    return `path=${args.filePath ?? args.path ?? ""}`;
  }
  if (name === "list_files") return `dir=${args.dirPath ?? "."}`;
  if (name === "search_files") return `query=${JSON.stringify(args.query ?? "")}`;
  if (name === "Glob") return `pattern=${JSON.stringify(args.pattern ?? "")}`;
  if (name === "Grep") return `pattern=${JSON.stringify(args.pattern ?? "")}`;
  if (name === "run_shell") return `command=${JSON.stringify(args.command ?? "")}`;
  if (name === "spawn_agent") return `task=${JSON.stringify(truncate(args.task ?? "", 60))}`;
  if (name === "apply_patch") return "patch=...";
  return Object.keys(args ?? {})
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
  return result.summary ?? JSON.stringify(result, null, 2);
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
