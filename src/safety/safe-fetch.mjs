import { evaluateUrl, loadAllowlistFromEnv } from "./network-allowlist.mjs";

/**
 * Phase 6 §2.4.1 — fetch wrapper that consults `PROCWAY_NET_ALLOW`.
 *
 * The default behaviour is "allow", so swapping `globalThis.fetch` for
 * `createSafeFetch()` is a no-op until the operator opts into the allowlist.
 * When the allowlist is non-empty:
 *   - matching hosts pass straight through
 *   - non-matching hosts dispatch an `approval.requested` event with kind
 *     `"network"` and `payload.url`/`payload.host` so adapters can prompt
 *
 * The brief asks Phase 6 to **audit + ask**, not block outright. We expose the
 * decision via `result.decision` so callers can also treat it as a hard deny
 * if they want.
 */

export function createSafeFetch({
  fetchImpl = globalThis.fetch,
  env = process.env,
  approvalRequester = null,
  logger = null,
  loadAllowlist = loadAllowlistFromEnv
} = {}) {
  if (!fetchImpl) {
    throw new Error("createSafeFetch: fetchImpl is required (no global fetch found)");
  }
  return async function safeFetch(input, init) {
    const allowlist = loadAllowlist(env);
    const decision = evaluateUrl(input?.url ?? input, allowlist);
    if (decision.decision === "ask" && approvalRequester) {
      const allowed = await approvalRequester({
        kind: "network",
        summary: decision.host ?? String(input),
        mutation: false,
        payload: { url: typeof input === "string" ? input : (input?.url ?? null), host: decision.host }
      });
      if (!allowed) {
        const error = new Error(`network egress denied: ${decision.host ?? "unknown"}`);
        error.code = "NET_ALLOWLIST_DENIED";
        throw error;
      }
    } else if (decision.decision === "ask" && logger?.warn) {
      logger.warn(`[safe-fetch] no approver wired; allowing egress to ${decision.host}`);
    }
    return fetchImpl(input, init);
  };
}

export { evaluateUrl, loadAllowlistFromEnv };
