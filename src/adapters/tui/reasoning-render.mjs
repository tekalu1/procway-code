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
 * On/off: `setEnabled(false)` — the REPL binds it to `/thinking [on|off]` and
 * seeds it from `settings.ui.thinking` (default on).
 */

import { style } from "./ansi.mjs";
import { wrapText } from "./panel.mjs";

export function createReasoningRenderer({
  writer = process.stdout,
  width = () => 80,
  colorize = false,
  enabled = true
} = {}) {
  return new ReasoningRenderer({ writer, width, colorize, enabled });
}

export class ReasoningRenderer {
  constructor({ writer, width, colorize, enabled }) {
    this.writer = writer;
    this.widthOf = typeof width === "function" ? width : () => Number(width) || 80;
    this.colorize = colorize;
    this.enabled = enabled !== false;
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

  setEnabled(value) {
    this.enabled = value !== false;
    if (!this.enabled) this.buffer = "";
    return this.enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  /** Buffer a delta; emit every complete line. */
  push(text) {
    if (!this.enabled || typeof text !== "string" || text === "") return;
    this.buffer += text;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      this.#emit(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }
  }

  /** Emit whatever is left (end of the reasoning phase). */
  flush() {
    if (this.buffer === "") return;
    const rest = this.buffer;
    this.buffer = "";
    if (this.enabled) this.#emit(rest);
  }

  #emit(line) {
    const text = line.trim();
    if (text === "") return;
    const width = Math.max(20, this.widthOf());
    const rows = wrapText(text, width - 2);
    const rendered = rows
      .map((row) => (this.colorize ? style(["muted", "italic"], `┊ ${row}`) : `┊ ${row}`))
      .join("\n");
    try { this.writer.write(`${rendered}\n`); } catch { /* ignore */ }
  }
}
