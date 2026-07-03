/**
 * Timeline renderer adapter — subscribes to the `EventBus` and writes
 * activity / model / tool / session frames to stderr (or any writable
 * stream). Phase 2 inverts the dependency: `core/` no longer imports the
 * TUI; it emits `activity.started` / `activity.stopped` events and this
 * adapter renders them.
 *
 * The renderer also listens for high-level events (`session.created`,
 * `tool.call.started`, `tool.call.completed`, `compact.applied`) so the
 * stderr feed remains as informative as the previous direct-write code.
 */

const FRAMES = ["-", "\\", "|", "/"];

export function createTimelineRenderer({ enabled = true, writer = process.stderr, intervalMs = 1000 } = {}) {
  return new TimelineRenderer({ enabled, writer, intervalMs });
}

export class TimelineRenderer {
  constructor({ enabled, writer, intervalMs }) {
    this.enabled = enabled;
    this.writer = writer;
    this.intervalMs = intervalMs;
    this.activeActivities = new Map();
    this.subscribed = false;
    this.bus = null;
    this.subscriptions = [];
  }

  attach(bus) {
    if (this.subscribed) return this;
    this.bus = bus;
    this.subscribe("session.created", (event) => this.#sessionLine(event));
    this.subscribe("session.resumed", (event) => this.#sessionLine(event));
    this.subscribe("activity.started", (event) => this.#startActivity(event));
    this.subscribe("activity.stopped", (event) => this.#stopActivity(event));
    this.subscribe("assistant.message.delta", () => this.#suspendSpinnersForStreaming());
    this.subscribe("tool.call.started", (event) => this.#line("tool", event.toolCallId ? `start id=${event.toolCallId}` : "start"));
    this.subscribe("tool.call.completed", (event) => this.#line("tool", `${event.ok ? "ok" : "failed"} ${event.result?.kind ?? ""}`.trim()));
    this.subscribe("compact.applied", (event) => this.#line("compact", `strategy=${event.strategy}`));
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
    this.bus = null;
    this.subscribed = false;
  }

  subscribe(type, handler) {
    this.bus.on(type, handler);
    this.subscriptions.push({ type, handler });
  }

  #sessionLine(event) {
    if (!this.enabled) return;
    const detail = event.type === "session.resumed"
      ? `resumed events=${event.from?.eventCount ?? 0}`
      : `start cwd=${event.cwd ?? ""}`;
    this.#line("session", detail);
  }

  #line(label, detail) {
    if (!this.enabled) return;
    const suffix = detail ? ` ${detail}` : "";
    this.writer.write(`[${new Date().toLocaleTimeString()}] ${label}${suffix}\n`);
  }

  #startActivity(event) {
    if (!this.enabled) return;
    const state = {
      activityId: event.activityId,
      label: event.label ?? "activity",
      detail: event.detail ?? "",
      startedAt: Date.now(),
      frameIndex: 0,
      timer: null,
      streaming: false
    };
    this.#renderActivityFrame(state);
    state.timer = setInterval(() => this.#renderActivityFrame(state), this.intervalMs);
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
      if (this.writer.isTTY) {
        this.writer.write("\r\x1b[2K");
      }
    }
  }

  #renderActivityFrame(state) {
    const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(0);
    const detailSuffix = state.detail ? ` ${state.detail}` : "";
    if (this.writer.isTTY) {
      const frame = FRAMES[state.frameIndex % FRAMES.length];
      state.frameIndex += 1;
      this.writer.write(`\r[${new Date().toLocaleTimeString()}] ${frame} ${state.label}${detailSuffix} (${elapsed}s)`);
    } else {
      this.writer.write(`[${new Date().toLocaleTimeString()}] ${state.label}${detailSuffix} still waiting (${elapsed}s)\n`);
    }
  }

  #stopActivity(event) {
    const state = this.activeActivities.get(event.activityId);
    if (!state) return;
    if (state.timer) clearInterval(state.timer);
    this.activeActivities.delete(event.activityId);
    if (!this.enabled) return;
    if (state.streaming) {
      // The streaming text on stdout is the visual conclusion; printing the
      // "response received" line on stderr would land on top of it and
      // garble the output. Skip the close-out frame for streamed turns.
      return;
    }
    const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(1);
    const outcome = event.outcome ?? "done";
    if (this.writer.isTTY) {
      this.writer.write(`\r[${new Date().toLocaleTimeString()}] ${state.label} ${outcome} (${elapsed}s)          \n`);
    } else {
      this.writer.write(`[${new Date().toLocaleTimeString()}] ${state.label} ${outcome} (${elapsed}s)\n`);
    }
  }
}
