import { describe, expect, it } from "vitest";
import { summarizeUsage, createUsageTracker } from "../src/usage-tracker.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";

const PRICING = {
  pricing: {
    "anthropic:claude-opus-4-7": { inputPer1k: 0.015, outputPer1k: 0.075 }
  }
};

describe("summarizeUsage", () => {
  it("aggregates totals and per-round breakdown", () => {
    const events = [
      { type: "usage.recorded", round: 0, inputTokens: 100, outputTokens: 50 },
      { type: "usage.recorded", round: 1, inputTokens: 200, outputTokens: 80 }
    ];
    const summary = summarizeUsage({
      events,
      settings: { defaultProvider: "anthropic", providers: { anthropic: { type: "anthropic", apiKeyEnv: "K", baseUrl: "u", defaultModel: "claude-opus-4-7" } }, usage: PRICING }
    });
    expect(summary.inputTokens).toBe(300);
    expect(summary.outputTokens).toBe(130);
    expect(summary.rounds).toHaveLength(2);
    // 100/1k * 0.015 + 50/1k * 0.075 = 0.0015 + 0.00375 = 0.00525
    expect(summary.rounds[0].costUsd).toBeCloseTo(0.00525, 6);
    expect(summary.costUsd).toBeGreaterThan(0);
  });

  it("warns when pricing is missing for the provider:model key", () => {
    const events = [{ type: "usage.recorded", round: 0, inputTokens: 100, outputTokens: 100 }];
    const summary = summarizeUsage({
      events,
      settings: { defaultProvider: "openai", providers: { openai: { type: "openai", apiKeyEnv: "K", baseUrl: "u", defaultModel: "unknown-model" } }, usage: { trackCost: true, pricing: {} } }
    });
    expect(summary.costUsd).toBe(0);
    expect(summary.diagnostics?.warnings).toContain("no pricing for openai:unknown-model");
  });

  it("uses event.costUsd when present and skips per-1k computation", () => {
    const events = [{ type: "usage.recorded", round: 0, inputTokens: 100, outputTokens: 100, costUsd: 0.0042 }];
    const summary = summarizeUsage({
      events,
      settings: { defaultProvider: "anthropic", providers: { anthropic: { type: "anthropic", apiKeyEnv: "K", baseUrl: "u", defaultModel: "claude-opus-4-7" } }, usage: PRICING }
    });
    expect(summary.rounds[0].costUsd).toBe(0.0042);
    expect(summary.costUsd).toBe(0.0042);
  });

  it("returns all-zero summary when no events are supplied", () => {
    const summary = summarizeUsage({ events: [] });
    expect(summary.inputTokens).toBe(0);
    expect(summary.outputTokens).toBe(0);
    expect(summary.costUsd).toBe(0);
    expect(summary.rounds).toEqual([]);
  });
});

describe("createUsageTracker", () => {
  it("captures usage.recorded events emitted on the session bus", async () => {
    const events = new EventBus();
    const session = {
      events,
      settings: { defaultProvider: "anthropic", providers: { anthropic: { type: "anthropic", apiKeyEnv: "K", baseUrl: "u", defaultModel: "claude-opus-4-7" } }, usage: PRICING }
    };
    const tracker = createUsageTracker({ session });
    events.emit(createEvent("usage.recorded", { sessionId: "s", round: 0, inputTokens: 50, outputTokens: 25 }));
    events.emit(createEvent("usage.recorded", { sessionId: "s", round: 1, inputTokens: 30, outputTokens: 10 }));
    const summary = tracker.summary();
    expect(summary.inputTokens).toBe(80);
    expect(summary.outputTokens).toBe(35);
    expect(summary.rounds).toHaveLength(2);
    tracker.dispose();
  });
});
