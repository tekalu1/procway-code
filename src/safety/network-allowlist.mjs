/**
 * Phase 6 §2.4.1 — egress allowlist for `safe-fetch`.
 *
 * Reads the allowlist from `env.PROCWAY_NET_ALLOW` (comma-separated host
 * suffixes, e.g. `api.openai.com,anthropic.com`). When unset the evaluator
 * returns `{ decision: "allow" }` for every host (back-compat). When set,
 * hosts that don't match any entry yield `{ decision: "ask" }`; the caller
 * (typically `safe-fetch` → ApprovalCoordinator) routes the request through
 * the existing approval pipeline rather than blocking outright.
 */

export function parseAllowlist(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts : null;
}

export function evaluateHost(host, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return { decision: "allow", host: normalizeHost(host) };
  }
  const target = normalizeHost(host);
  if (!target) return { decision: "ask", host: target, reason: "no host" };
  for (const entry of allowlist) {
    if (entry === target) return { decision: "allow", host: target, matched: entry };
    if (target.endsWith(`.${entry}`)) return { decision: "allow", host: target, matched: entry };
  }
  return { decision: "ask", host: target, reason: "host not in PROCWAY_NET_ALLOW" };
}

export function evaluateUrl(input, allowlist) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    return { decision: "ask", host: null, reason: "invalid URL" };
  }
  return evaluateHost(url.hostname, allowlist);
}

export function loadAllowlistFromEnv(env = process.env) {
  return parseAllowlist(env?.PROCWAY_NET_ALLOW);
}

function normalizeHost(host) {
  if (typeof host !== "string") return null;
  return host.trim().toLowerCase().replace(/\.+$/, "");
}
