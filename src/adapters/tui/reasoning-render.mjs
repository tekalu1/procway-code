/**
 * `assistant.reasoning.delta` on the terminal (P3b-8).
 *
 * Providers with visible chain-of-thought (openai-codex reasoning models,
 * Anthropic extended thinking) emit these deltas; `turn-orchestrator.mjs` has
 * forwarded them onto the bus since Phase 2 and the dashboard renders them —
 * but the CLI subscribed to nothing, so the one channel that proves the model
 * is alive during a multi-minute reasoning phase was dropped on the floor.
 *
 * Rendering rules:
 *  - dim, prefixed with a `┊` gutter, so it never reads as the answer;
 *  - line-buffered and wrapped: a delta is a few tokens, and writing raw
 *    fragments would interleave with the spinner mid-word;
 *  - flushed on the first `assistant.message.delta` (the answer has started)
 *    and at the end of the turn.
 *
 * ## Display modes (P3-14)
 *
 * A long reasoning phase can occupy most of the screen, so the renderer now
 * has three modes instead of a bare on/off:
 *
 *   - `full`   — stream every reasoning line as it completes (the original
 *                behaviour; `/thinking on` / setEnabled(true)).
 *   - `folded` — buffer the whole phase and print ONE summary line at the end
 *                (e.g. `┊ thinking (42 lines)`). The screen stays small by
 *                default; the detail is a `/thinking full` away.
 *   - `hidden` — drop the reasoning entirely (`/thinking off` /
 *                setEnabled(false)).
 *
 * Mode precedence: an explicit `mode:` wins, then `defaultMode:` (what the
 * REPL seeds), then `enabled === false` → hidden, then `full`. `/thinking`
 * toggles: bare `/thinking` cycles hidden → folded → full.
 */

import { style } from "./ansi.mjs";
import { wrapText } from "./panel.mjs";

export function createReasoningRenderer({
  writer = process.stdout,
  width = () => 80,
  colorize = false,
  enabled = true,
  mode = null,
  defaultMode = "full"
} = {}) {
  return new ReasoningRenderer({ writer, width, colorize, enabled, mode, defaultMode });
}

function normaliseMode(value) {
  const v = String(value ?? "").toLowerCase();
  if (v === "hidden" || v === "off" || v === "false") return "hidden";
  if (v === "folded" || v === "fold") return "folded";
  return "full";
}

function resolveInitialMode({ enabled, mode, defaultMode }) {
  if (mode != null) return normaliseMode(mode);
  if (enabled === false) return "hidden";
  return normaliseMode(defaultMode ?? "full");
}

export class ReasoningRenderer {
  constructor({ writer, width, colorize, enabled = true, mode = null, defaultMode = "full" }) {
    this.writer = writer;
    this.widthOf = typeof width === "function" ? width : () => Number(width) || 80;
    this.colorize = colorize;
    this.mode = resolveInitialMode({ enabled, mode, defaultMode });
    this.buffer = "";
    this.bus = null;
    this.subscriptions = [];
  }

  attach(bus) {
    if (!bus || this.bus) return this;
    this.bus = bus;
    this.subscribe("assistant.reasoning.delta", (event) => this.push(event?.deltaText));
    this.subscribe("assistant.message.delta", () => this.flush());
    this.subscribe("assistant.message.completed", () => this.flush());
    this.subscribe("turn.completed", () => this.flush());
    this.subscribe("turn.failed", () => this.flush());
    return this;
  }

  detach() {
    if (!this.bus) return;
    for (const { type, handler } of this.subscriptions) this.bus.off(type, handler);
    this.subscriptions = [];
    this.bus = null;
    this.buffer = "";
  }

  subscribe(type, handler) {
    this.bus.on(type, handler);
    this.subscriptions.push({ type, handler });
  }

  /** Set the display mode: "hidden" | "folded" | "full" (also accepts aliases). */
  setMode(value) {
    const next = normaliseMode(value);
    if (next !== this.mode) {
      this.mode = next;
      // Switching modes mid-phase: a partial line belongs to the old mode.
      this.buffer = "";
    }
    return this.mode;
  }

  getMode() {
    return this.mode;
  }

  /** Backward-compatible on/off: `false` → hidden, `true` → full. */
  setEnabled(value) {
    const next = value === false ? "hidden" : "full";
    if (next !== this.mode) this.buffer = "";
    this.mode = next;
    return this.mode !== "hidden";
  }

  isEnabled() {
    return this.mode !== "hidden";
  }

  isFolded() {
    return this.mode === "folded";
  }

  /** Buffer a delta; in `full` mode emit every complete line immediately. */
  push(text) {
    if (typeof text !== "string" || text === "") return;
    if (this.mode === "hidden") return;
    this.buffer += text;
    if (this.mode !== "full") return;
    // Full mode streams lines as they complete; the tail stays buffered.
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      this.#emitLine(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }
  }

  /** Emit whatever is left (end of the reasoning phase). */
  flush() {
    if (this.buffer === "") return;
    const rest = this.buffer;
    this.buffer = "";
    if (this.mode === "hidden") return;
    if (this.mode === "folded") {
      const n = countLines(rest);
      if (n > 0) this.#emitFoldedSummary(n);
      return;
    }
    this.#emitLine(rest);
  }

  #emitLine(line) {
    const text = line.trim();
    if (text === "") return;
    const width = Math.max(20, this.widthOf());
    const rows = wrapText(text, width - 2);
    const rendered = rows
      .map((row) => (this.colorize ? style(["muted", "italic"], `┊ ${row}`) : `┊ ${row}`))
      .join("\n");
    try { this.writer.write(`${rendered}\n`); } catch { /* ignore */ }
  }

  #emitFoldedSummary(lineCount) {
    const noun = lineCount === 1 ? "line" : "lines";
    const text = `┊ thinking (${lineCount} ${noun}) — /thinking full to expand`;
    const rendered = this.colorize ? style(["muted", "italic"], text) : text;
    try { this.writer.write(`${rendered}\n`); } catch { /* ignore */ }
  }
}

function countLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}
