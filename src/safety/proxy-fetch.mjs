/**
 * Proxy-aware fetch for the agent's OUTBOUND network tools.
 *
 * In the k8s session Pod, direct egress is denied by NetworkPolicy and the
 * only way out is the egress proxy (HTTP_PROXY/HTTPS_PROXY/NO_PROXY are
 * injected by the engine — k8s-engine.ts buildEnv). Node's BUILT-IN fetch
 * ignores those env vars entirely, so every WebSearch / WebFetch /
 * Jira / Confluence call died with ECONNREFUSED while curl/git/pnpm (which
 * honor the env) worked fine.
 *
 * undici's EnvHttpProxyAgent reads HTTP_PROXY/HTTPS_PROXY and respects
 * NO_PROXY — critical here, because cluster-internal traffic (the LLM broker
 * on procway-dashboard.<ns>.svc) must NOT be routed into squid (it only
 * allows ports 80/443 to the outside).
 *
 * When no proxy env is present (LOCAL dev, tests, host runs) this returns
 * globalThis.fetch — byte-identical behavior.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

let agent = null;

export function getProxyAwareFetch(env = process.env) {
  const proxied = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxied) return globalThis.fetch;
  // One process-wide agent: it re-reads NO_PROXY per request, and pooling
  // beats constructing a dispatcher per call.
  agent ??= new EnvHttpProxyAgent();
  return (input, init = {}) => undiciFetch(input, { ...init, dispatcher: agent });
}

/** Test-only: drop the cached dispatcher so env changes take effect. */
export function _resetProxyAgentForTest() {
  agent = null;
}
