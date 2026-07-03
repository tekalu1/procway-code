/**
 * Auth helper for MCP integration tools (Phase C / Phase G1).
 *
 * Reads `.procway-connections.json` from the workspace (chmod 600 file
 * written by the dashboard's connection store) and turns the stored
 * credential into (baseUrl, headers).
 *
 * Why a separate copy of the dashboard's _auth.ts logic: ai-agent is a
 * standalone Node process that runs inside the procway-code runtime
 * container and does NOT import from `dashboard/` (no shared package
 * yet). The dashboard's connection plugin keeps the on-disk file fresh
 * via its periodic health check + refresh sweep, so we just read it
 * here and trust the token.
 */

import { existsSync } from "node:fs";
import { getProxyAwareFetch } from "../../safety/proxy-fetch.mjs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const UA = "procway-mcp-host";

export class IntegrationNotConnectedError extends Error {
  constructor(connectionId) {
    super(`Connection "${connectionId}" is not configured. Connect it in the dashboard at Settings > Connections.`);
    this.name = "IntegrationNotConnectedError";
    this.code = "NOT_CONNECTED";
    this.connectionId = connectionId;
  }
}

export class IntegrationApiError extends Error {
  constructor(connectionId, method, url, status, bodyText) {
    super(`${connectionId} ${method} ${url} → ${status}: ${(bodyText || "").slice(0, 300)}`);
    this.name = "IntegrationApiError";
    this.code = "INTEGRATION_API_ERROR";
    this.connectionId = connectionId;
    this.method = method;
    this.url = url;
    this.status = status;
    this.bodyText = bodyText;
  }
}

/**
 * Find the dashboard's `.procway-connections.json` file.
 *
 * Lookup order (first match wins):
 *   1. `PROCWAY_WORKSPACE_URI` env (set by the runtime image — points
 *      to `file:///procway-workspaces`, the shared named volume where
 *      the dashboard's connection store writes the file).
 *   2. Walk up from `cwd` looking for the file. Covers host dev where
 *      the MCP host is invoked from inside the repo.
 *   3. Fall back to `${cwd}/.procway-connections.json` so the dashboard
 *      and ai-agent stay agnostic of the URI scheme in tests.
 *
 * Returns the absolute path even when the file doesn't exist — the
 * caller checks readability separately.
 */
function resolveConnectionsPath(cwd) {
  const envUri = process.env.PROCWAY_WORKSPACE_URI?.trim();
  if (envUri) {
    const dir = parseLocalUri(envUri);
    if (dir) return join(dir, ".procway-connections.json");
  }
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, ".procway-connections.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return join(cwd, ".procway-connections.json");
}

/**
 * Parse a `file://` URI (or a bare absolute path) into a filesystem path.
 * Returns null when the input is empty / malformed.
 */
function parseLocalUri(uri) {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("file://")) {
    let p = trimmed.slice("file://".length);
    // `file:///abs` — host part empty, path starts at `/`. `file://host/abs`
    // (rare) would put a host name first; for procway-local use it's
    // always empty so the slice above yields the absolute path.
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // strip Windows leading slash
    return p;
  }
  return trimmed;
}

/**
 * Read .procway-connections.json from the workspace. Returns the parsed
 * object or null when the file is missing/unreadable. The dashboard
 * writes this file with chmod 600; ai-agent runs as the same user
 * inside the runtime container so the read permission carries over.
 */
async function readConnectionsFile(cwd) {
  const path = resolveConnectionsPath(cwd);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build (baseUrl, headers) for a given connection id. Throws
 * IntegrationNotConnectedError when no credential is stored.
 */
export async function resolveAuthForConnection(cwd, id) {
  const file = await readConnectionsFile(cwd);
  const stored = file?.[id];
  if (!stored) throw new IntegrationNotConnectedError(id);
  switch (id) {
    case "github": return buildGithubAuth(stored);
    case "jira": return buildJiraAuth(stored);
    case "confluence": return buildConfluenceAuth(stored);
    case "slack": return buildSlackAuth(stored);
    default:
      throw new Error(`Integration auth not implemented for "${id}"`);
  }
}

function buildGithubAuth(stored) {
  // oauth-device (OAuth App) and github-app-user (GitHub App, ADR 0025) both
  // carry a bearer `accessToken` and hit the same REST surface — accept either.
  if (stored.kind !== "oauth-device" && stored.kind !== "github-app-user") {
    throw new Error(`Unsupported GitHub credential kind: ${stored.kind}`);
  }
  return {
    baseUrl: "https://api.github.com",
    headers: {
      Authorization: `token ${stored.accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    meta: { kind: stored.kind }
  };
}

function basicHeader(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

function normalizeHost(host) {
  return String(host).replace(/\/+$/, "");
}

function buildJiraAuth(stored) {
  if (stored.kind === "oauth-3lo") {
    if (!stored.cloudId) {
      throw new Error("Jira OAuth credential has no cloudId. Re-run the OAuth flow in the dashboard.");
    }
    return {
      baseUrl: `https://api.atlassian.com/ex/jira/${encodeURIComponent(stored.cloudId)}`,
      headers: {
        Authorization: `Bearer ${stored.accessToken}`,
        Accept: "application/json",
        "User-Agent": UA
      },
      meta: { kind: stored.kind, cloudId: stored.cloudId, siteUrl: stored.siteUrl }
    };
  }
  if (stored.kind === "api-token") {
    if (!stored.host || !stored.email) {
      throw new Error("Jira API token credential needs host and email.");
    }
    const host = normalizeHost(stored.host);
    return {
      baseUrl: host,
      headers: {
        Authorization: basicHeader(stored.email, stored.token),
        Accept: "application/json",
        "User-Agent": UA
      },
      meta: { kind: stored.kind, siteUrl: host }
    };
  }
  throw new Error(`Unsupported Jira credential kind: ${stored.kind}`);
}

function buildConfluenceAuth(stored) {
  if (stored.kind === "oauth-3lo") {
    if (!stored.cloudId) {
      throw new Error("Confluence OAuth credential has no cloudId. Re-run the OAuth flow in the dashboard.");
    }
    return {
      baseUrl: `https://api.atlassian.com/ex/confluence/${encodeURIComponent(stored.cloudId)}/wiki`,
      headers: {
        Authorization: `Bearer ${stored.accessToken}`,
        Accept: "application/json",
        "User-Agent": UA
      },
      meta: { kind: stored.kind, cloudId: stored.cloudId, siteUrl: stored.siteUrl }
    };
  }
  if (stored.kind === "api-token") {
    if (!stored.host || !stored.email) {
      throw new Error("Confluence API token credential needs host and email.");
    }
    const host = normalizeHost(stored.host);
    return {
      baseUrl: `${host}/wiki`,
      headers: {
        Authorization: basicHeader(stored.email, stored.token),
        Accept: "application/json",
        "User-Agent": UA
      },
      meta: { kind: stored.kind, siteUrl: host }
    };
  }
  throw new Error(`Unsupported Confluence credential kind: ${stored.kind}`);
}

function buildSlackAuth(stored) {
  if (stored.kind !== "oauth-bot") {
    throw new Error(`Unsupported Slack credential kind: ${stored.kind}`);
  }
  return {
    baseUrl: "https://slack.com/api",
    headers: {
      Authorization: `Bearer ${stored.accessToken}`,
      Accept: "application/json",
      "User-Agent": UA
    },
    meta: { kind: stored.kind, teamId: stored.teamId, teamName: stored.teamName, botUserId: stored.botUserId }
  };
}

function buildUrl(base, path, query) {
  const sep = path.startsWith("/") ? "" : "/";
  let url = `${base}${sep}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    const qstr = qs.toString();
    if (qstr) url += (url.includes("?") ? "&" : "?") + qstr;
  }
  return url;
}

/**
 * Generic JSON-in / JSON-out fetch wrapper for a given connection.
 * Throws IntegrationApiError on non-2xx responses.
 */
export async function callApi({ cwd, id, method = "GET", path, query, body, fetchImpl }) {
  const auth = await resolveAuthForConnection(cwd, id);
  const url = buildUrl(auth.baseUrl, path, query);
  const headers = { ...auth.headers };
  let serialized;
  if (body !== undefined && body !== null) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    serialized = JSON.stringify(body);
  }
  // Proxy-aware default: api.atlassian.com etc. are only reachable through
  // the egress proxy inside the session Pod (see safety/proxy-fetch.mjs).
  const fetcher = fetchImpl ?? getProxyAwareFetch();
  const res = await fetcher(url, { method, headers, body: serialized });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new IntegrationApiError(id, method, url, res.status, text);
  }
  if (res.status === 204) return undefined;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}
