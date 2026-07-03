import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import { EVENT_TYPES, createEvent, isAgentEvent } from "../src/core/events/types.mjs";

describe("EventBus", () => {
  it("delivers an event to a single subscriber", () => {
    const bus = new EventBus();
    const received = [];
    bus.on("turn.completed", (event) => received.push(event));
    const event = createEvent("turn.completed", { round: 0, exitCode: 0 });
    bus.emit(event);
    expect(received).toEqual([event]);
  });

  it("fans out to multiple subscribers of the same type", () => {
    const bus = new EventBus();
    const calls = [];
    bus.on("usage.recorded", () => calls.push("a"));
    bus.on("usage.recorded", () => calls.push("b"));
    bus.emit(createEvent("usage.recorded", { round: 0, inputTokens: 1, outputTokens: 1 }));
    expect(calls).toEqual(["a", "b"]);
  });

  it("delivers every type to wildcard subscribers", () => {
    const bus = new EventBus();
    const seen = [];
    bus.on("*", (event) => seen.push(event.type));
    bus.emit(createEvent("turn.completed", { round: 0, exitCode: 0 }));
    bus.emit(createEvent("usage.recorded", { round: 0, inputTokens: 5, outputTokens: 7 }));
    expect(seen).toEqual(["turn.completed", "usage.recorded"]);
  });

  it("stops invoking a handler after off()", () => {
    const bus = new EventBus();
    const calls = [];
    const handler = (event) => calls.push(event.round);
    bus.on("turn.completed", handler);
    bus.emit(createEvent("turn.completed", { round: 0, exitCode: 0 }));
    bus.off("turn.completed", handler);
    bus.emit(createEvent("turn.completed", { round: 1, exitCode: 0 }));
    expect(calls).toEqual([0]);
  });

  it("treats duplicate on(type, handler) as a no-op", () => {
    const bus = new EventBus();
    let count = 0;
    const handler = () => { count += 1; };
    bus.on("turn.completed", handler);
    bus.on("turn.completed", handler);
    bus.emit(createEvent("turn.completed", { round: 0, exitCode: 0 }));
    expect(count).toBe(1);
  });

  it("captures handler exceptions and continues delivering to peers", () => {
    const bus = new EventBus();
    const sentinel = new Error("boom");
    const survivors = [];
    bus.on("turn.completed", () => { throw sentinel; });
    bus.on("turn.completed", (event) => survivors.push(event.round));
    const event = createEvent("turn.completed", { round: 3, exitCode: 0 });
    bus.emit(event);
    expect(survivors).toEqual([3]);
    expect(bus.errors).toHaveLength(1);
    expect(bus.errors[0]).toMatchObject({
      origin: "emit",
      type: "turn.completed",
      error: sentinel,
      event
    });
  });

  it("captures replay-time handler exceptions and tags them with origin: \"replay\"", () => {
    const bus = new EventBus();
    const sentinel = new Error("replay boom");
    const seen = [];
    bus.replay(
      [
        createEvent("turn.completed", { round: 0, exitCode: 0 }),
        createEvent("turn.completed", { round: 1, exitCode: 0 }),
        createEvent("turn.completed", { round: 2, exitCode: 0 })
      ],
      (event) => {
        if (event.round === 1) throw sentinel;
        seen.push(event.round);
      }
    );
    expect(seen).toEqual([0, 2]);
    expect(bus.errors).toHaveLength(1);
    expect(bus.errors[0]).toMatchObject({
      origin: "replay",
      type: "turn.completed",
      error: sentinel
    });
    expect(bus.errors[0].event.round).toBe(1);
  });

  it("replays an iterable of events in order", () => {
    const bus = new EventBus();
    const events = [
      createEvent("turn.completed", { round: 0, exitCode: 0 }),
      createEvent("turn.completed", { round: 1, exitCode: 0 }),
      createEvent("turn.completed", { round: 2, exitCode: 0 })
    ];
    const seen = [];
    bus.replay(events, (event) => seen.push(event.round));
    expect(seen).toEqual([0, 1, 2]);
  });

  it("rejects emit() values that fail isAgentEvent", () => {
    const bus = new EventBus();
    expect(() => bus.emit({ type: "not-a-real-type" })).toThrow(TypeError);
    expect(isAgentEvent({ type: "not-a-real-type" })).toBe(false);
  });

  it("auto-fills eventId and time via createEvent", () => {
    const event = createEvent("usage.recorded", { round: 0, inputTokens: 0, outputTokens: 0 });
    expect(typeof event.eventId).toBe("string");
    expect(event.eventId.length).toBeGreaterThan(0);
    expect(typeof event.time).toBe("string");
    expect(Number.isNaN(Date.parse(event.time))).toBe(false);
    expect(event.type).toBe("usage.recorded");
  });

  it("exposes the canonical EVENT_TYPES list covering Phase 7 events", () => {
    expect(EVENT_TYPES).toContain("session.created");
    expect(EVENT_TYPES).toContain("turn.failed");
    expect(EVENT_TYPES).toContain("plan.queued");
    expect(EVENT_TYPES).toContain("todos.updated");
    expect(EVENT_TYPES).toContain("memory.loaded");
    expect(EVENT_TYPES).toContain("hook.executed");
    expect(EVENT_TYPES.length).toBeGreaterThanOrEqual(18);
  });
});
