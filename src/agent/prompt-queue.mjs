import { createEvent } from "../core/events/types.mjs";
import { USER_INTERRUPT_CODE } from "./abort.mjs";

/** A session-owned queue, shared by every attached surface. Its run lease
 * covers the entire chain so workers cannot retire their Pod between prompts. */
export class PromptQueue {
  constructor(session, runOne) {
    this.session = session;
    this.runOne = runOne;
    this.items = [];
    this.active = false;
    this.interruptId = null;
    this.stopped = false;
    this.terminal = null;
    session.events.on("*", event => {
      if (this.active && (event.type === "turn.completed" || event.type === "turn.failed")) this.terminal = event;
    });
  }

  list() {
    return this.items.map(({ id, prompt, options }) => ({
      id, prompt, attachments: options.attachments ?? []
    }));
  }

  publish(settled = null) {
    this.session.events.emit(createEvent("prompt.queue.updated", {
      sessionId: this.session.sessionId, prompts: this.list(), ...(settled ? { settled } : {})
    }));
  }

  async enqueue(id, prompt, options = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid queued prompt id");
    if (this.items.some(item => item.id === id)) return;
    if (this.items.length >= 32) throw new Error("Too many queued prompts (max 32)");
    this.items.push({ id, prompt, options });
    this.publish();
    await this.session.save({ force: true });
    // The turn may have ended while the sender was connecting. Start the
    // queued prompt through the same lease, never run two model turns at once.
    if (!this.active && !this.session.runningTurn && !this.session.pausedForInput && !this.session.pausedForApproval?.length) this.startDetached();
  }

  async remove(id) {
    const found = this.items.some(item => item.id === id);
    this.items = this.items.filter(item => item.id !== id);
    if (this.interruptId === id) this.interruptId = null;
    this.publish();
    await this.session.save({ force: true });
    return found;
  }

  async sendNow(id) {
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) return;
    const [item] = this.items.splice(index, 1);
    this.items.unshift(item);
    this.stopped = false;
    this.interruptId = id;
    this.publish();
    if (this.session.runningTurn) this.session.abort();
    await this.session.save({ force: true });
    if (!this.active && !this.session.runningTurn) this.startDetached();
  }

  startDetached() {
    const item = this.items.shift();
    if (!item) return;
    this.publish();
    // runOne emits the normal turn.failed event. No detached rejection may
    // escape just because its browser has navigated away.
    void this.run(item.prompt, item.options).catch(() => {});
  }

  async run(prompt, options = {}, firstTurn = null) {
    if (this.active || this.session.runningTurn) {
      const error = new Error("A turn is already in progress for this session.");
      error.code = "TURN_IN_PROGRESS";
      throw error;
    }
    this.active = true;
    this.stopped = false;
    this.terminal = null;
    try {
      let result = await (firstTurn ? firstTurn() : this.runOne(prompt, options));
      await this.session.save({ force: true });
      while (this.items.length && !this.stopped
        && !this.session.pausedForInput && !this.session.pausedForApproval?.length
        && (this.terminal?.type !== "turn.failed" || (this.terminal.error?.code === USER_INTERRUPT_CODE && this.interruptId != null))) {
        const item = this.items.shift();
        this.interruptId = null;
        this.publish();
        // Retain the original turn's restrictions and provider seam. A queued
        // instruction cannot relax a read-only worker's policy.
        result = await this.runOne(item.prompt, { ...options, ...item.options, wake: false, toolPolicy: options.toolPolicy ?? item.options.toolPolicy });
        await this.session.save({ force: true });
      }
      return result;
    } catch (error) {
      // A failed final snapshot must not let a worker report success.
      if (this.terminal?.type !== "turn.failed") {
        this.session.events.emit(createEvent("turn.failed", {
          sessionId: this.session.sessionId,
          error: { code: error?.code ?? "PROMPT_QUEUE_FAILED", message: error?.message ?? String(error) }
        }));
      }
      throw error;
    } finally {
      this.active = false;
      this.interruptId = null;
      this.publish(this.terminal);
      this.session.wakeSupervisor?.notifyTurnSettled();
    }
  }
}
