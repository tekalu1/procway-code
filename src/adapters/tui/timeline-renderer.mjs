/**
 * Timeline renderer adapter — subscribes to the `EventBus` and writes
 * activity / model / tool / session frames to a writable sink. Phase 2
 * inverted the dependency: `core/` no longer imports the TUI; it emits
 * `activity.started` / `activity.stopped` events and this adapter renders
 * them.
 *
 * P1-6: the tool lines are produced by `tool-render.mjs#renderToolCall` — the
 * same function the replayed transcript uses — as its "no result yet" case,
 * so the live feed and the recap print byte-identical headers. Arguments come
 * from `tool.call.scheduled` (`tool.call.started` carries only the name).
 *
 * Phase 3b (P3b-2) fixed four things that made the live feed look broken:
 *
 *  1. `activity.started` fires for BOTH the model round and every tool call,
 *     and `tool.call.started` fires for the same tool call — so each tool ran
 *     twice on screen (`✦ tool:read_file running` then `● read_file(path=…)`).
 *     Tool activities are now dropped here; the `tool.call.*` pair is the
 *     richer of the two.
 *  2. Every line carried a locale-dependent 12-hour timestamp
 *     (`[11:44:14 PM] `). Gone — a REPL is not a log file.
 *  3. The spinner ticked once a second, which reads as "frozen". Now ~100ms.
 *  4. A spinner frame ends without a newline, so the NEXT line landed on top
 *     of it: `… model waiting round=0 (0s)[11:44:14 PM] model waiting failed`.
 *     Every line-write now clears a dirty spinner row first.
 *
 * The sink is the input controller's `writer` in the REPL, so a spinner can
 * never overwrite an approval prompt (Phase 2 hand-off): `isBusy()` reports
 * when something is reading keys and the spinner simply holds still.
 */

import { renderToolCall } from "./tool-render.mjs";
import { formatDuration } from "./format.mjs";
import { style, supportsColor, visibleWidth } from "./ansi.mjs";
import { stripAnsi } from "./ansi.mjs";
import { sanitizeInline } from "./sanitize.mjs";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** TTY spinner cadence. 100ms ≈ 10fps: smooth without burning a core. */
export const SPINNER_INTERVAL_MS = 100;
/** Non-TTY (piped / CI) heartbeat cadence — one line every 10s, not 10/second. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

export function createTimelineRenderer({
  enabled = true,
  writer = process.stderr,
  intervalMs = SPINNER_INTERVAL_MS,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  colorize,
  isBusy = null,
  width = 80
} = {}) {
  return new TimelineRenderer({ enabled, writer, intervalMs, heartbeatMs, colorize, isBusy, width });
}

export class TimelineRenderer {
  constructor({ enabled, writer, intervalMs, heartbeatMs, colorize, isBusy, width = 80 }) {
    this.enabled = enabled;
    this.writer = writer;
    this.intervalMs = intervalMs;
    this.heartbeatMs = heartbeatMs;
    // Single colour decision (P1-3): supportsColor honours NO_COLOR /
    // FORCE_COLOR / TERM=dumb, which a bare `isTTY` check did not.
    this.colorize = colorize ?? supportsColor(writer);
    this.widthOf = typeof width === "function" ? width : () => Number(width) || 80;
    this.isBusy = typeof isBusy === "function" ? isBusy : () => false;
    this.activeActivities = new Map();
    this.subscribed = false;
    this.bus = null;
    this.subscriptions = [];
    this.toolCalls = new Map();
    /**
     * Terminal row (newline offset) at which each in-flight tool's "start"
     * line was written, so the completion line can overwrite it in place
     * instead of adding a second row (P3-14: one line per tool, not two). Each
     * entry also carries a `render(frame)` so the running bullet can spin.
     */
    this.toolStartRows = new Map();
    /**
     * Same single-row lifecycle for the in-flight compaction: the "compacting"
     * row spins while the summary request runs, then `compact.applied`
     * overwrites it in place with the result (see `#compactStarted`).
     */
    this.compactionRow = null;
    /**
     * Shared interval that animates the bullet of the currently-running row
     * (tool or compaction — see `#tickRowSpinner`). Lazily started on a TTY
     * when such a row appears and stopped once none is in flight.
     */
    this.toolSpinner = null;
    /** Number of newlines written so far — where the cursor currently sits. */
    this.cursorRow = 0;
    /** True while a spinner frame is on the current row with no newline yet. */
    this.spinnerDirty = false;
  }

  attach(bus) {
    if (this.subscribed) return this;
    this.bus = bus;
    this.subscribe("activity.started", (event) => this.#startActivity(event));
    this.subscribe("activity.stopped", (event) => this.#stopActivity(event));
    this.subscribe("assistant.message.delta", () => this.#suspendSpinnersForStreaming());
    this.subscribe("tool.call.scheduled", (event) => this.#toolScheduled(event));
    this.subscribe("tool.call.started", (event) => this.#toolStarted(event));
    this.subscribe("tool.call.completed", (event) => this.#toolCompleted(event));
    this.subscribe("compact.started", (event) => this.#compactStarted(event));
    this.subscribe("compact.applied", (event) => this.#compactApplied(event));
    this.subscribed = true;
    return this;
  }

  detach() {
    if (!this.bus) return;
    for (const { type, handler } of this.subscriptions) this.bus.off(type, handler);
    this.subscriptions = [];
    for (const activity of this.activeActivities.values()) {
      if (activity.timer) clearInterval(activity.timer);
    }
    this.activeActivities.clear();
    if (this.toolSpinner) {
      clearInterval(this.toolSpinner);
      this.toolSpinner = null;
    }
    this.toolCalls.clear();
    this.toolStartRows.clear();
    this.compactionRow = null;
    this.bus = null;
    this.subscribed = false;
  }

  subscribe(type, handler) {
    this.bus.on(type, handler);
    this.subscriptions.push({ type, handler });
  }

  get isTTY() {
    return this.writer?.isTTY === true;
  }

  /** True when the sink is a persistent-prompt dock (input controller writer). */
  #hasDock() {
    return this.writer?.hasDock === true;
  }

  /** Write a complete line, clearing a half-drawn spinner row first. */
  #line(text) {
    if (!this.enabled) return;
    this.#write(`${text}\n`);
  }

  #write(text) {
    // When the sink is the input controller it clears the transient row
    // itself (it also knows about the prompt); a raw stream does not, so we
    // clear our own spinner row here.
    const prefix = this.spinnerDirty && this.isTTY ? "\r\x1b[2K" : "";
    this.spinnerDirty = false;
    // Keep a cursor-row ledger local to this renderer's writes (the tool
    // in-place overwrite relies on it). Newlines measure rows; a transient
    // frame writes on the same row, so it never changes the ledger.
    this.cursorRow += (String(text).match(/\n/g) || []).length;
    this.writer.write(`${prefix}${text}`);
  }

  /**
   * Replace the tool's "… started" line with its "… done" line in place, so a
   * tool occupies ONE row through its whole lifecycle instead of two.
   * `text` must be a single row (`renderToolCall` without a result body). Only
   * safe on a TTY when nothing else has been written since the start line —
   * otherwise we fall back to a fresh completion row.
   */
  #writeToolCompletion(text, record) {
    if (this.#hasDock()) {
      // A persistent bottom dock sits below the content, so the cursor is never
      // on the row under the tool — the `\x1b[1A` in-place trick would clobber
      // the dock. Drop the status spinner and commit a fresh completion row;
      // the dock repaints below it.
      if (typeof this.writer.clearTransient === "function") this.writer.clearTransient();
      this.#write(text);
      return;
    }
    const { row: startRow, singleRow } = record;
    const rowsSinceStart = this.cursorRow - (startRow + 1);
    if (singleRow && this.isTTY && rowsSinceStart === 0 && !this.spinnerDirty) {
      this.#rewindAndRewrite(text);
      return;
    }
    this.#write(text);
  }

  /**
   * Overwrite the row directly above the cursor in place. `#write` counts the
   * trailing newline, so the ledger returns to the caller's row — the physical
   * `\x1b[1A` up one and the `\n` back down cancel out.
   */
  #rewindAndRewrite(text) {
    this.cursorRow -= 1; // step back; #write's newline count returns it
    this.#write(`\x1b[1A\r\x1b[2K${text}`);
  }

  /** Lazily start the shared running-row animation (TTY only). */
  #ensureRowSpinner() {
    if (!this.isTTY || this.toolSpinner) return;
    this.toolSpinner = setInterval(() => this.#tickRowSpinner(), this.intervalMs);
    if (this.toolSpinner && typeof this.toolSpinner.unref === "function") this.toolSpinner.unref();
  }

  /** Stop the animation once no tool or compaction row is in flight. */
  #stopRowSpinnerIfIdle() {
    if (this.toolStartRows.size > 0 || this.compactionRow) return;
    if (this.toolSpinner) {
      clearInterval(this.toolSpinner);
      this.toolSpinner = null;
    }
  }

  /** Every animated single-row record: in-flight tools plus a compaction. */
  #spinnableRows() {
    const rows = [];
    for (const rec of this.toolStartRows.values()) rows.push(rec);
    if (this.compactionRow) rows.push(this.compactionRow);
    return rows;
  }

  /**
   * Animate the bullet of the bottom-most running row (tool or compaction).
   * Only the row directly above the cursor can be repainted in place
   * (`\x1b[1A` reaches one physical row), so we spin just that one and leave
   * the others holding a static ●. It shares the exact same guards as
   * `#writeToolCompletion` — if anything was written below it since, it holds
   * still rather than risk clobbering another row. Parallel tools (or a tool
   * racing a compaction) thus animate only the visually-current row, which
   * still reads as "busy".
   */
  #tickRowSpinner() {
    if (!this.enabled || !this.isTTY || this.isBusy()) return;
    if (this.#hasDock()) {
      // The spinning bullet lives on the dock's status row (pinned above the
      // input), where writeTransient repaints it in place — no physical `\x1b[1A`
      // row math, so every running single-row target can animate. Only the
      // bottom-most is shown, matching the visual "currently running" row.
      let target = null;
      for (const rec of this.#spinnableRows()) {
        if (rec.singleRow && (!target || rec.row > target.row)) target = rec;
      }
      if (!target) return;
      target.frameIndex += 1;
      const frame = FRAMES[target.frameIndex % FRAMES.length];
      if (typeof this.writer.writeTransient === "function") this.writer.writeTransient(this.#firstRow(target.render(frame)));
      return;
    }
    let target = null;
    for (const rec of this.#spinnableRows()) {
      const rowsSinceStart = this.cursorRow - (rec.row + 1);
      if (rec.singleRow && rowsSinceStart === 0 && !this.spinnerDirty && (!target || rec.row > target.row)) {
        target = rec;
      }
    }
    if (!target) return;
    target.frameIndex += 1;
    const frame = FRAMES[target.frameIndex % FRAMES.length];
    this.#rewindAndRewrite(target.render(frame));
  }

  /**
   * `compact.started` opens a tools-style running row so the TUI is visibly
   * busy while the (possibly slow) summary request is in flight; `compact.applied`
   * later overwrites that same row in place with the result. See `#compactApplied`.
   */
  #compactStarted(event) {
    if (!this.enabled) return;
    const idle = "compacting conversation";
    const line = (glyph) =>
      `${this.#paint(glyph, "accentStrong")} ${idle}${this.#paint(` (strategy=${sanitizeInline(event.strategy ?? "?")})`, "muted")}\n`;
    const plain = stripAnsi(line("●")).trimEnd();
    const singleRow = plain.split("\n").length === 1 && visibleWidth(plain) <= this.widthOf();
    const startRow = this.cursorRow;
    this.compactionRow = {
      row: startRow,
      singleRow,
      frameIndex: -1,
      render: (frame) => line(frame)
    };
    if (this.#hasDock()) {
      // Same as tools: on a dock sink the running row lives on the STATUS row
      // (transient, pinned above the input) — committing it here too would
      // leave a stale "compacting…" row in the scrollback once the result row
      // lands.
      this.#writeTransient(line("●"));
      this.#ensureRowSpinner();
      return;
    }
    this.#write(line("●"));
    this.#ensureRowSpinner();
  }

  #compactApplied(event) {
    if (!this.enabled) return;
    const strategy = sanitizeInline(event.strategy ?? "?");
    const rec = this.compactionRow;
    this.compactionRow = null;
    if (rec) {
      const noop = event.compacted === false;
      const glyph = this.#paint(noop ? "○" : "✓", noop ? "muted" : "success");
      const label = `compacting conversation ${this.#paint(`${noop ? "done (nothing to compact)" : "compacted"} (strategy=${strategy})`, "muted")}\n`;
      this.#writeToolCompletion(`${glyph} ${label}`, rec);
      this.#stopRowSpinnerIfIdle();
      return;
    }
    // Back-compat: a `compact.applied` without a matching `compact.started`
    // (replayed transcript / imported feed) still lands as a plain line.
    this.#line(`compacted (strategy=${strategy})`);
  }

  /**
   * A transient status frame is ONE physical row and must not end in a
   * newline: the dock's writer appends its own `\r\n` when it draws the row,
   * so a trailing `\n` in the text (as produced by `renderToolCall`) would
   * force a real line-feed, push the status row into the scrollback, and leave
   * a stale "● …" row under the later "✓ …" row. `#firstRow` keeps just the
   * first line of the header (dropping the result body and any trailing LF).
   */
  #firstRow(text) {
    const lines = String(text ?? "").split(/\r?\n/);
    return lines.find((line) => line.trim() !== "") ?? lines[0] ?? "";
  }

  /** A frame that the next write replaces. */
  #writeTransient(text) {
    const row = this.#firstRow(text);
    if (typeof this.writer.writeTransient === "function") {
      this.writer.writeTransient(row);
      return;
    }
    this.writer.write(`\r\x1b[2K${row}`);
    this.spinnerDirty = true;
  }

  #paint(text, names) {
    return this.colorize ? style(names, text) : text;
  }

  /**
   * `tool.call.scheduled` is the only event carrying the tool ARGUMENTS, and
   * it is emitted before `tool.call.started`. Remember them so both the start
   * and the completion line can show `run_shell(command="pnpm test")`.
   */
  #toolScheduled(event) {
    if (!event?.toolCallId) return;
    this.toolCalls.set(event.toolCallId, { name: event.name ?? "tool", args: event.args ?? {} });
  }

  #toolStarted(event) {
    const name = event.name ?? this.toolCalls.get(event.toolCallId)?.name ?? "tool";
    const args = this.toolCalls.get(event.toolCallId)?.args ?? {};
    if (event.toolCallId) this.toolCalls.set(event.toolCallId, { name, args });
    if (!this.enabled) return;
    const start = renderToolCall({ name, args, status: "start", colorize: this.colorize });
    // Record which row this tool's start line lands on so its completion can
    // overwrite it in place (P3-14: one row per tool, not two). Only eligible
    // when the header is a single unwrapped row — otherwise a cursor-up would
    // hit the wrong line on a narrow terminal.
    const startText = stripAnsi(start).trimEnd();
    const singleRow = startText.split("\n").length === 1 && visibleWidth(startText) <= this.widthOf();
    const startRow = this.cursorRow;
    const record = {
      row: startRow,
      singleRow,
      frameIndex: -1,
      render: (frame) => renderToolCall({ name, args, status: "start", frame, colorize: this.colorize })
    };
    if (this.#hasDock()) {
      // On a dock sink the running line belongs on the STATUS row (transient,
      // pinned above the input): committing it to the scrollback here too would
      // leave the "… started" row standing after the completion row lands, so a
      // finished tool would linger as both a running row and a done row.
      if (event.toolCallId) {
        this.toolStartRows.set(event.toolCallId, record);
        this.#ensureRowSpinner();
      }
      this.#writeTransient(record.render("●"));
      return;
    }
    this.#write(start);
    if (event.toolCallId) {
      this.toolStartRows.set(event.toolCallId, record);
      this.#ensureRowSpinner();
    }
  }

  #toolCompleted(event) {
    const call = this.toolCalls.get(event.toolCallId);
    const name = call?.name ?? event.result?.kind ?? "tool";
    const args = call?.args ?? {};
    if (event.toolCallId) this.toolCalls.delete(event.toolCallId);
    if (!this.enabled) return;
    // `result: null` on purpose — the live feed shows the call, not its body;
    // the body is what the transcript recap prints. Same renderer, same line.
    const rendered = renderToolCall({
      name,
      args,
      status: event.ok === false ? "error" : "ok",
      colorize: this.colorize
    });
    // Turn the "started" ● row into the "done" ✓/✗ row without adding a line.
    const startRow = this.toolStartRows.get(event.toolCallId);
    if (startRow !== undefined) {
      this.toolStartRows.delete(event.toolCallId);
      this.#writeToolCompletion(rendered, startRow);
      this.#stopRowSpinnerIfIdle();
    } else {
      this.#write(rendered);
    }
  }

  /**
   * Tool activities duplicate `tool.call.started` / `tool.call.completed`,
   * which carry the arguments — so only non-tool activities (the model round)
   * get a spinner.
   */
  #isToolActivity(event) {
    return typeof event?.label === "string" && event.label.startsWith("tool:");
  }

  #startActivity(event) {
    if (!this.enabled || this.#isToolActivity(event)) return;
    const state = {
      activityId: event.activityId,
      // Activity labels/details are built from the model id and (for delegated
      // work) the sub-agent's task text. They are re-printed ~10 times a second
      // as a spinner frame with no trailing newline, so a stray control
      // character here would be replayed onto the same row indefinitely.
      label: sanitizeInline(event.label) || "activity",
      detail: sanitizeInline(event.detail),
      startedAt: Date.now(),
      lastHeartbeatAt: 0,
      frameIndex: 0,
      timer: null,
      streaming: false
    };
    this.#renderActivityFrame(state);
    state.timer = setInterval(() => this.#renderActivityFrame(state), this.isTTY ? this.intervalMs : this.heartbeatMs);
    state.timer?.unref?.();
    this.activeActivities.set(event.activityId, state);
  }

  #suspendSpinnersForStreaming() {
    if (!this.enabled) return;
    for (const state of this.activeActivities.values()) {
      if (state.streaming) continue;
      state.streaming = true;
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      if (this.isTTY) {
        if (this.#hasDock()) {
          if (typeof this.writer.clearTransient === "function") this.writer.clearTransient();
        } else {
          this.writer.write("\r\x1b[2K");
        }
        this.spinnerDirty = false;
      }
    }
  }

  #renderActivityFrame(state) {
    // Something is reading keys (an approval prompt, the session picker): the
    // spinner must not paint over it. It resumes on the next tick.
    if (this.isBusy()) return;
    const elapsed = formatDuration(Date.now() - state.startedAt);
    const detailSuffix = state.detail ? ` ${state.detail}` : "";
    if (this.isTTY) {
      const frame = FRAMES[state.frameIndex % FRAMES.length];
      state.frameIndex += 1;
      this.#writeTransient(`${this.#paint(frame, "accentStrong")} ${state.label}${this.#paint(`${detailSuffix} (${elapsed})`, "muted")}`);
      return;
    }
    const now = Date.now();
    if (state.lastHeartbeatAt !== 0 && now - state.lastHeartbeatAt < this.heartbeatMs) return;
    state.lastHeartbeatAt = now;
    this.writer.write(`${state.label}${detailSuffix} still waiting (${elapsed})\n`);
  }

  #stopActivity(event) {
    const state = this.activeActivities.get(event.activityId);
    if (!state) return;
    if (state.timer) clearInterval(state.timer);
    this.activeActivities.delete(event.activityId);
    if (!this.enabled) return;
    if (state.streaming) {
      // The streaming text on stdout is the visual conclusion; printing the
      // "response received" line would land on top of it and garble the
      // output. Skip the close-out frame for streamed turns.
      return;
    }
    const elapsed = formatDuration(Date.now() - state.startedAt);
    const outcome = sanitizeInline(event.outcome) || "done";
    const failed = /fail|error|abort/i.test(String(outcome));
    const glyph = this.#paint(failed ? "✗" : "✓", failed ? "danger" : "success");
    this.#line(`${glyph} ${state.label} ${this.#paint(`${outcome} (${elapsed})`, "muted")}`);
  }
}
