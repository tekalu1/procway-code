import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSession, usageCommand } from "../src/core/index.mjs";
import { createEvent } from "../src/core/events/types.mjs";

describe("/usage command (unified cost + per-round breakdown)", () => {
  let cwd;
  let session;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "procway-usage-"));
    session = await createAgentSession({
      settings: {
        defaultProvider: "anthropic",
        providers: { anthropic: { type: "anthropic", apiKeyEnv: "K", baseUrl: "u", defaultModel: "claude-opus-4-7" } },
        session: { enabled: false },
        usage: { trackCost: true, pricing: { "anthropic:claude-opus-4-7": { inputPer1k: 0.015, outputPer1k: 0.075 } } }
      },
      cwd,
      sessionId: "usage-1"
    });
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("returns cumulative tokens and USD estimate in totals", async () => {
    session.events.emit(createEvent("usage.recorded", { sessionId: "usage-1", round: 0, inputTokens: 1000, outputTokens: 500 }));
    session.events.emit(createEvent("usage.recorded", { sessionId: "usage-1", round: 1, inputTokens: 200, outputTokens: 100 }));
    const result = await usageCommand({ session });
    expect(result.totals.inputTokens).toBe(1200);
    expect(result.totals.outputTokens).toBe(600);
    expect(result.totals.costUsd).toBeGreaterThan(0);
    expect(result.pricingKey).toBe("anthropic:claude-opus-4-7");
  });

  it("returns per-round breakdown alongside totals", async () => {
    session.events.emit(createEvent("usage.recorded", { sessionId: "usage-1", round: 0, inputTokens: 100, outputTokens: 50 }));
    session.events.emit(createEvent("usage.recorded", { sessionId: "usage-1", round: 1, inputTokens: 200, outputTokens: 80 }));
    const result = await usageCommand({ session });
    expect(result.totals.inputTokens).toBe(300);
    expect(result.totals.outputTokens).toBe(130);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].round).toBe(0);
    expect(result.rounds[1].round).toBe(1);
  });

  it("reports a missing-pricing warning when the model has no entry", async () => {
    const wcwd = await mkdtemp(path.join(os.tmpdir(), "procway-usage-warn-"));
    try {
      const wsession = await createAgentSession({
        settings: {
          defaultProvider: "anthropic",
          providers: { anthropic: { type: "anthropic", apiKeyEnv: "K", baseUrl: "u", defaultModel: "unknown" } },
          session: { enabled: false },
          usage: { trackCost: true, pricing: {} }
        },
        cwd: wcwd,
        sessionId: "usage-warn"
      });
      wsession.events.emit(createEvent("usage.recorded", { sessionId: "usage-warn", round: 0, inputTokens: 50, outputTokens: 50 }));
      const result = await usageCommand({ session: wsession });
      expect(result.totals.costUsd).toBe(0);
      expect(result.diagnostics?.warnings ?? []).toContain("no pricing for anthropic:unknown");
    } finally {
      await rm(wcwd, { recursive: true, force: true });
    }
  });
});
