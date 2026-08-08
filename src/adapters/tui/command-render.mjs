/**
 * Formatted output for the slash commands that used to print
 * `console.log(JSON.stringify(result, null, 2))` (P3b-1): `/usage`,
 * `/context`, `/plan`, `/todos`, `/memory`, `/branch`, `/compact`.
 *
 * Every function here is pure — it takes the exact object the matching
 * `core/commands/*.mjs` returns and gives back a string — so the REPL keeps
 * `cli.mjs` free of layout code and the shapes stay under test.
 */

import path from "node:path";
import { renderChecklist, renderPanel, renderTable, paint } from "./panel.mjs";
import { formatBytes, formatCount, formatUsd } from "./format.mjs";

/**
 * `/usage` — a right-aligned per-round table plus a totals row.
 *
 * @param {{ pricingKey?: string|null, totals?: object, rounds?: Array<object>,
 *           diagnostics?: { warnings?: string[] } }} result
 */
export function renderUsage(result, { width = 80, color = true } = {}) {
  const totals = result?.totals ?? {};
  const rounds = Array.isArray(result?.rounds) ? result.rounds : [];
  const table = renderTable({
    title: "Usage",
    subtitle: result?.pricingKey ?? "no pricing key",
    columns: [
      { key: "round", label: "round", align: "right" },
      { key: "input", label: "input", align: "right" },
      { key: "output", label: "output", align: "right" },
      { key: "cost", label: "cost", align: "right" }
    ],
    rows: rounds.map((entry) => ({
      round: String(entry?.round ?? 0),
      input: formatCount(entry?.inputTokens),
      output: formatCount(entry?.outputTokens),
      cost: formatUsd(entry?.costUsd)
    })),
    footer: {
      round: "total",
      input: formatCount(totals.inputTokens ?? 0),
      output: formatCount(totals.outputTokens ?? 0),
      cost: formatUsd(totals.costUsd ?? 0)
    },
    width,
    color,
    empty: "(no model rounds yet)"
  });
  const warnings = result?.diagnostics?.warnings ?? [];
  if (warnings.length === 0) return table;
  return `${table}${renderPanel({
    rows: warnings.map((warning) => `! ${warning}`),
    notes: ["Set settings.usage.pricing[\"provider:model\"] to see costs."],
    width,
    color
  })}`;
}

/**
 * `/context` — the resolved instruction files and skills, grouped and shown
 * as workspace-relative paths (the absolute ones were unreadable at 80 cols).
 */
export function renderContext(result, { width = 80, color = true, cwd = process.cwd() } = {}) {
  const instructions = Array.isArray(result?.instructions) ? result.instructions : [];
  const skills = Array.isArray(result?.skills) ? result.skills : [];
  const head = renderPanel({
    title: "Context",
    subtitle: `compatibility: ${result?.compatibilityMode ?? "unknown"}`,
    rows: [
      ["instructions", `${instructions.length} file${instructions.length === 1 ? "" : "s"}`],
      ["skills", `${skills.length} file${skills.length === 1 ? "" : "s"}`]
    ],
    width,
    color
  });
  const instructionTable = renderTable({
    title: "Instructions",
    columns: [
      { key: "scanner", label: "scanner" },
      { key: "path", label: "path" },
      { key: "size", label: "size", align: "right" }
    ],
    rows: instructions.map((item) => ({
      scanner: item?.scannerId ?? "-",
      path: relativePath(item?.path, cwd),
      size: formatBytes(item?.bytes)
    })),
    width,
    color,
    empty: "(no instruction files resolved)"
  });
  const skillTable = renderTable({
    title: "Skills",
    columns: [
      { key: "scanner", label: "scanner" },
      { key: "priority", label: "prio", align: "right" },
      { key: "path", label: "path" },
      { key: "size", label: "size", align: "right" }
    ],
    rows: skills.map((item) => ({
      scanner: item?.scannerId ?? "-",
      priority: item?.priority == null ? "-" : String(item.priority),
      path: relativePath(item?.path, cwd),
      size: formatBytes(item?.bytes)
    })),
    width,
    color,
    empty: "(no skills resolved)"
  });
  return `${head}\n${instructionTable}\n${skillTable}`;
}

/** `/todos` — a real checklist (the old output was a one-line summary + JSON). */
export function renderTodos(result, { width = 80, color = true } = {}) {
  const todos = Array.isArray(result?.todos) ? result.todos : [];
  const summary = result?.summary ?? {};
  const done = Number(summary.completed ?? todos.filter((todo) => todo?.status === "completed").length);
  const total = Number(summary.total ?? todos.length);
  return renderChecklist({
    title: "Todos",
    subtitle: total > 0 ? `${done}/${total} done` : null,
    items: todos.map((todo) => ({
      status: todo?.status,
      text: todo?.status === "in_progress" ? (todo?.activeForm || todo?.content || "") : (todo?.content ?? "")
    })),
    width,
    color
  });
}

/** `/memory` — counts by type, then the entries themselves. */
export function renderMemory(result, { width = 80, color = true } = {}) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  const types = result?.types ?? {};
  const head = renderPanel({
    title: "Memory",
    subtitle: result?.dir ?? "no memory directory",
    rows: [
      ["entries", String(result?.count ?? entries.length)],
      ["by type", Object.entries(types).map(([type, count]) => `${type}=${count}`).join("  ") || "-"]
    ],
    width,
    color
  });
  const table = renderTable({
    columns: [
      { key: "type", label: "type" },
      { key: "name", label: "name" },
      { key: "description", label: "description" }
    ],
    rows: entries.map((entry) => ({
      type: entry?.type ?? "-",
      name: entry?.name ?? entry?.file ?? "-",
      description: entry?.description ?? ""
    })),
    width,
    color,
    empty: "(no memory entries)"
  });
  return `${head}\n${table}`;
}

/** `/plan` — the mode state plus whatever writes are queued behind it. */
export function renderPlan(result, { width = 80, color = true } = {}) {
  if (result?.available === false) {
    return renderPanel({
      title: "Plan mode",
      rows: [["state", "unavailable", "muted"]],
      notes: ["This session was created without plan mode support."],
      width,
      color
    });
  }
  const pending = Array.isArray(result?.pending) ? result.pending : [];
  const head = renderPanel({
    title: "Plan mode",
    rows: [
      ["state", result?.active ? "on" : "off", result?.active ? "warning" : "muted"],
      ["queued", `${pending.length} write${pending.length === 1 ? "" : "s"}`]
    ],
    notes: result?.active
      ? ["Write tools are queued and approved at the end of the turn. /plan off to disable."]
      : ["/plan on queues write tools for end-of-turn approval."],
    width,
    color
  });
  if (pending.length === 0) return head;
  return `${head}\n${renderTable({
    columns: [
      { key: "name", label: "tool" },
      { key: "summary", label: "summary" }
    ],
    rows: pending.map((entry) => ({ name: entry?.name ?? "-", summary: entry?.summary ?? "" })),
    width,
    color
  })}`;
}

/** `/branch` — success reports where the branch went; failure reports why. */
export function renderBranch(result, { width = 80, color = true, cwd = process.cwd() } = {}) {
  if (!result?.ok) {
    return renderPanel({
      title: "Branch",
      rows: [["error", result?.error ?? "failed", "danger"]],
      notes: [result?.hint ?? "Usage: /branch from <messageId>"],
      width,
      color
    });
  }
  return renderPanel({
    title: "Branch",
    subtitle: "created",
    rows: [
      ["session", result.branchSessionId, "success"],
      ["from", result.fromMessageId],
      ["files", relativePath(result.branchDir, cwd)]
    ],
    notes: [`/checkout ${result.branchSessionId} to switch to it.`],
    width,
    color
  });
}

/** `/compact` — both the `--status` report and the applied-pass report. */
export function renderCompact(result, { width = 80, color = true } = {}) {
  if (result?.status) {
    const status = result.status;
    return renderPanel({
      title: "Compaction",
      subtitle: status.enabled === false ? "disabled" : "auto",
      rows: [
        ["messages", `${formatCount(status.messageCount)} / ${formatCount(status.messageCountThreshold)}`],
        ["est. tokens", `${formatCount(status.estimatedTokens)} / ${formatCount(status.estimatedTokensThreshold)}`],
        ["strategy", status.strategy ?? "-"],
        ["keep last", String(status.keepLastMessages ?? "-")],
        ["due now", status.shouldCompact ? "yes" : "no", status.shouldCompact ? "warning" : "muted"]
      ],
      width,
      color
    });
  }
  if (result?.compacted === false) {
    return renderPanel({
      title: "Compaction",
      rows: [
        ["result", "nothing to compact", "muted"],
        ["messages", formatCount(result?.messageCount)]
      ],
      width,
      color
    });
  }
  return renderPanel({
    title: "Compaction",
    subtitle: "applied",
    rows: [
      ["strategy", result?.strategy ?? "-"],
      ["removed", `${formatCount(result?.removedMessages)} message${result?.removedMessages === 1 ? "" : "s"}`, "success"],
      ["keep last", String(result?.keepLastMessages ?? "-")],
      ["messages", formatCount(result?.messageCount)]
    ],
    width,
    color
  });
}

/**
 * `/model` — one line, but coloured like the rest of the shell so the answer
 * to "which model am I talking to" does not look like debug output.
 */
export function renderModel(result, { color = true } = {}) {
  return `${paint("model", "muted", color)}  ${paint(`${result?.provider ?? "unconfigured"}:${result?.model ?? "unconfigured"}`, "accentStrong", color)}\n`;
}

function relativePath(target, cwd) {
  if (typeof target !== "string" || target.length === 0) return "-";
  if (typeof cwd !== "string" || cwd.length === 0) return target;
  const relative = path.relative(cwd, target);
  if (!relative || relative.startsWith("..")) return target;
  return relative;
}
