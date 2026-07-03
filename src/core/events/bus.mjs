import { isAgentEvent } from "./types.mjs";

const WILDCARD = "*";

/**
 * Minimal synchronous event bus for `core/`.
 *
 * Design constraints (Phase 1):
 * - emit / on / off / replay only
 * - duplicate (type, handler) registration is a no-op
 * - handler exceptions are caught and pushed to `bus.errors`; the loop continues
 * - no I/O — does not touch process.stdout / process.stderr / console
 *
 * Phase 3 (phase1_E-1): each error entry now carries `origin: "emit" | "replay"`
 * so post-mortem inspection can distinguish a runtime emit failure from a
 * replay-time failure (e.g. when reconstructing state from events.jsonl).
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<(event: import("./types.mjs").AgentEvent) => void>>} */
    this.handlers = new Map();
    /** @type {Array<{ origin: "emit" | "replay", type: string, error: unknown, event: import("./types.mjs").AgentEvent }>} */
    this.errors = [];
  }

  on(typeOrAll, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("EventBus.on: handler must be a function");
    }
    const key = String(typeOrAll);
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
  }

  off(typeOrAll, handler) {
    const key = String(typeOrAll);
    const set = this.handlers.get(key);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(key);
  }

  emit(event) {
    if (!isAgentEvent(event)) {
      throw new TypeError("EventBus.emit: value is not a recognized AgentEvent");
    }
    this.#dispatch(event.type, event);
    if (event.type !== WILDCARD) this.#dispatch(WILDCARD, event);
  }

  replay(events, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("EventBus.replay: handler must be a function");
    }
    for (const event of events) {
      if (!isAgentEvent(event)) continue;
      try {
        handler(event);
      } catch (error) {
        this.errors.push({ origin: "replay", type: event.type, error, event });
      }
    }
  }

  #dispatch(key, event) {
    const set = this.handlers.get(key);
    if (!set || set.size === 0) return;
    for (const handler of Array.from(set)) {
      try {
        handler(event);
      } catch (error) {
        this.errors.push({ origin: "emit", type: event.type, error, event });
      }
    }
  }
}
