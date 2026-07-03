import { summarizeUsage } from "../../usage-tracker.mjs";

/**
 * `/usage` — round-by-round breakdown for the current session. Pure.
 */
export async function usageCommand({ session } = {}) {
  if (!session) throw new TypeError("usageCommand: session is required");
  const tracker = session.usageTracker;
  const summary = tracker?.summary?.() ?? summarizeUsage({ events: [], settings: session.settings });
  return {
    sessionId: session.sessionId,
    pricingKey: summary.pricingKey,
    totals: {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      costUsd: summary.costUsd
    },
    rounds: summary.rounds,
    diagnostics: summary.diagnostics
  };
}
