import { resolveActiveModel } from "./config/active-model.mjs";

/**
 * UsageTracker — listens for `usage.recorded` events on an EventBus, keeps
 * the per-round entries in memory, and exposes `summary()` for `/cost` and
 * `/usage`. Stays attached for the whole session lifetime; callers `dispose()`
 * before tearing the session down.
 */
export function createUsageTracker({ session, initialEvents = [] } = {}) {
  if (!session?.events || typeof session.events.on !== "function") {
    throw new TypeError("createUsageTracker: session with events bus is required");
  }
  const events = Array.isArray(initialEvents) ? initialEvents.slice() : [];
  const handler = (event) => {
    if (event?.type === "usage.recorded") events.push(event);
  };
  session.events.on("usage.recorded", handler);
  session.usageTracker = {
    summary() {
      return summarizeUsage({ events, settings: session.settings });
    },
    raw() {
      return events.slice();
    },
    dispose() {
      session.events.off("usage.recorded", handler);
    }
  };
  return session.usageTracker;
}

/**
 * Pure aggregator — converts a stream of `usage.recorded` events into a
 * round-by-round breakdown plus a cumulative summary, with optional USD
 * pricing per `provider:model` key.
 *
 * Phase 5 §2.10. Pure module — no I/O. Both the `/cost` and `/usage` REPL
 * commands consume `summarizeUsage` to produce their structured response.
 *
 * Pricing structure (also documented in `default-settings.mjs`):
 *
 *   settings.usage.pricing = {
 *     "anthropic:claude-opus-4-7": { inputPer1k: 0.015, outputPer1k: 0.075 },
 *     ...
 *   }
 *
 * If a key is missing, the round's cost is zero and a `no pricing for X`
 * warning is added to `diagnostics.warnings`.
 */
export function summarizeUsage({
  events,
  settings = {},
  provider = settings.defaultProvider,
  model = resolveActiveModel(settings)
} = {}) {
  const pricing = settings.usage?.pricing ?? {};
  const trackCost = settings.usage?.trackCost !== false;
  const key = providerModelKey(provider, model);
  const knownPrice = trackCost ? pricing[key] : null;
  const warnings = new Set();
  const rounds = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const event of events ?? []) {
    if (!event || event.type !== "usage.recorded") continue;
    const entry = {
      round: Number.isFinite(event.round) ? event.round : 0,
      inputTokens: numberOrZero(event.inputTokens),
      outputTokens: numberOrZero(event.outputTokens),
      costUsd: 0
    };
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
      entry.costUsd = event.costUsd;
    } else if (knownPrice) {
      entry.costUsd = roundCost((entry.inputTokens / 1000) * (knownPrice.inputPer1k ?? 0)
        + (entry.outputTokens / 1000) * (knownPrice.outputPer1k ?? 0));
    } else if (trackCost && key) {
      warnings.add(`no pricing for ${key}`);
    }
    costUsd += entry.costUsd;
    rounds.push(entry);
  }
  return {
    inputTokens,
    outputTokens,
    costUsd: roundCost(costUsd),
    rounds,
    pricingKey: key,
    diagnostics: warnings.size > 0 ? { warnings: [...warnings] } : undefined
  };
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function providerModelKey(provider, model) {
  if (!provider || !model) return null;
  return `${provider}:${model}`;
}

function roundCost(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e8) / 1e8;
}
