/**
 * Dashboard-managed remote MCP servers, derived from the connections
 * snapshot (`.procway-connections.json`, written by the dashboard's
 * connection store and mounted into the session Pod).
 *
 * Rows keyed `mcp:<slug>` with kind "mcp-remote" become MCP server configs
 * in the same shape as `settings.mcpServers.<id>` (HTTP/SSE only — the
 * dashboard never distributes stdio commands). Tools surface as
 * `mcp__<slug>__<tool>`.
 *
 * Token freshness: the dashboard's refresh sweep is the ONLY refresher for
 * OAuth-backed rows (rotating refresh tokens must have a single writer);
 * it rewrites the snapshot after every refresh. The `authProvider` hook
 * attached to each server re-reads the snapshot on start and on 401, so a
 * long-lived session picks up swept tokens without a restart — the Pod
 * itself never sees a refresh token.
 */
import { readConnectionsFile } from "../tools/integrations/_auth.mjs";

const MCP_KEY_PREFIX = "mcp:";
// Mirrors the dashboard's slug rule (dashboard/server/connections/ids.ts).
// No underscores: `mcp__<slug>__<tool>` splits on `__`.
const MCP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function buildHeaders(stored) {
  return {
    ...(stored.headers ?? {}),
    ...(stored.auth === "oauth" && typeof stored.oauth?.accessToken === "string" && stored.oauth.accessToken
      ? { Authorization: `Bearer ${stored.oauth.accessToken}` }
      : {})
  };
}

/**
 * Load `mcp:<slug>` rows from the connections snapshot as an mcpServers-
 * shaped map (keyed by slug). Returns {} when the snapshot is missing.
 * Malformed rows are skipped with a warning — the snapshot is produced by
 * the dashboard, but the agent must not die on a bad row.
 */
export async function loadConnectionsMcpServers(cwd, { logger = console } = {}) {
  const file = await readConnectionsFile(cwd);
  if (!file) return {};
  const servers = {};
  for (const [key, stored] of Object.entries(file)) {
    if (key === "version" || !key.startsWith(MCP_KEY_PREFIX)) continue;
    const slug = key.slice(MCP_KEY_PREFIX.length);
    if (!MCP_SLUG_RE.test(slug)) {
      logger?.warn?.(`[mcp] Skipping connection "${key}": invalid slug`);
      continue;
    }
    if (!stored || typeof stored !== "object" || stored.kind !== "mcp-remote") {
      logger?.warn?.(`[mcp] Skipping connection "${key}": unexpected kind`);
      continue;
    }
    if (stored.enabled === false) continue;
    if (typeof stored.baseUrl !== "string" || stored.baseUrl.length === 0) {
      logger?.warn?.(`[mcp] Skipping connection "${key}": missing baseUrl`);
      continue;
    }
    servers[slug] = {
      transport: stored.transport === "sse" ? "sse" : "http",
      baseUrl: stored.baseUrl,
      headers: buildHeaders(stored),
      // Re-read the snapshot for the freshest credential (see module doc).
      authProvider: async () => {
        const latest = await readConnectionsFile(cwd);
        const row = latest?.[key];
        if (!row || typeof row !== "object" || row.kind !== "mcp-remote") return {};
        return buildHeaders(row);
      }
    };
  }
  return servers;
}
