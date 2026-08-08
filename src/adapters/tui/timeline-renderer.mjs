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
import { style, supportsColor } from "./ansi.mjs";
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
  isBusy = null
} = {}) {
  return new TimelineRenderer({ enabled, writer, intervalMs, heartbeatMs, colorize, isBusy });
}

export class TimelineRenderer {
  constructor({ enabled, writer, intervalMs, heartbeatMs, colorize, isBusy }) {
    this.enabled = enabled;
    this.writer = writer;
    this.intervalMs = intervalMs;
    this.heartbeatMs = heartbeatMs;
    // Single colour decision (P1-3): supportsColor honours NO_COLOR /
    // FORCE_COLOR / TERM=dumb, which a bare `isTTY` check did not.
    this.colorize = colorize ?? supportsColor(writer);
    this.isBusy = typeof isBusy === "function" ? isBusy : () => false;
    this.activeActivities = new Map();
    this.subscribed = false;
    this.bus = null;
    this.subscriptions = [];
    this.toolCalls = new Map();
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
    this.subscribe("compact.applied", (event) => this.#line(`compacted (strategy=${sanitizeInline(event.strategy)})`));
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
    this.toolCalls.clear();
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
    this.writer.write(`${prefix}${text}`);
  }

  /** A frame that the next write replaces. */
  #writeTransient(text) {
    if (typeof this.writer.writeTransient === "function") {
      this.writer.writeTransient(text);
      return;
    }
    this.writer.write(`\r\x1b[2K${text}`);
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
    this.#write(renderToolCall({ name, args, status: "start", colorize: this.colorize }));
  }

  #toolCompleted(event) {
    const call = this.toolCalls.get(event.toolCallId);
    const name = call?.name ?? event.result?.kind ?? "tool";
    const args = call?.args ?? {};
    if (event.toolCallId) this.toolCalls.delete(event.toolCallId);
    if (!this.enabled) return;
    // `result: null` on purpose — the live feed shows the call, not its body;
    // the body is what the transcript recap prints. Same renderer, same line.
    this.#write(renderToolCall({
      name,
      args,
      status: event.ok === false ? "error" : "ok",
      colorize: this.colorize
    }));
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
        this.writer.write("\r\x1b[2K");
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
