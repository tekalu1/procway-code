/**
 * `/mcp` — list, add and remove MCP servers for the active session.
 *
 * The TUI REPL has no settings hot-reload, so every mutation here (add /
 * remove) persists the change to the settings file, updates the in-memory
 * `session.settings.mcpServers`, and calls `session.reconnectMcpTools()` so
 * the next model round ships the updated tool set.
 *
 * Listing is pure (no I/O) and derives a per-server status snapshot from the
 * live MCP registry + settings. The pure helpers `parseMcpAddArgs` and
 * `validateMcpServerConfig` are exported so the direct non-interactive form
 * (`/mcp add <id> <transport> ...`) and the interactive TUI wizard share the
 * same parsing/validation and stay under test.
 */
import { getSettingsPath, readScopedSettings, writeScopedSettings, setSetting } from "../../config/workspace-settings.mjs";
import { validateSettings } from "../../config/schema.mjs";

export const MCP_TRANSPORTS = Object.freeze(["stdio", "http", "sse"]);

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a single server entry against the settings schema.
 * @returns {string[]} human-readable errors (empty when valid).
 */
export function validateMcpServerConfig(serverId, config) {
  if (!SERVER_ID_PATTERN.test(serverId)) {
    return [`mcpServers.${serverId}: id must be letters, digits, "-" or "_"`];
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [`mcpServers.${serverId}: config must be an object`];
  }
  return validateSettings({ mcpServers: { [serverId]: config } })
    .filter((error) => error.startsWith(`mcpServers.${serverId}`));
}

/**
 * Build the `/mcp` list snapshot. Pure: no I/O.
 *
 * @param {{ session?: { mcpRegistry?: object, settings?: object } }} input
 */
export async function mcpListCommand({ session } = {}) {
  const registry = session?.mcpRegistry ?? null;
  const config = registry?.settings?.mcpServers ?? session?.settings?.mcpServers ?? {};
  const connected = new Set(registry?.servers?.keys?.() ?? []);
  const servers = [];
  for (const id of Object.keys(config)) {
    const server = config[id] ?? {};
    const isConnected = connected.has(id);
    const status = server.enabled === false
      ? "disabled"
      : (isConnected ? "connected" : "failed");
    const tools = isConnected ? (registry.servers.get(id)?.tools ?? []) : [];
    servers.push({
      id,
      transport: server.transport ?? "stdio",
      target: server.command ?? server.baseUrl ?? "",
      enabled: server.enabled !== false,
      status,
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name)
    });
  }
  return {
    ok: true,
    connected: servers.filter((s) => s.status === "connected").length,
    failed: servers.filter((s) => s.status === "failed").length,
    disabled: servers.filter((s) => s.status === "disabled").length,
    servers
  };
}

/**
 * Parse the direct (non-interactive) form:
 *   add <id> <transport> [--command <cmd>] [--args <a> ...]
 *     [--base-url <url>] [--header k=v ...] [--scope user|workspace]
 *     [--enabled true|false]
 * @returns {{ serverId, transport, config, scope } | { error }}
 */
export function parseMcpAddArgs(args = []) {
  const [serverId, transportRaw, ...rest] = args;
  if (!serverId) {
    return { error: "Usage: /mcp add <id> <transport> [--command <cmd>] [--args <a> ...] [--base-url <url>] [--header k=v] [--scope user|workspace] [--enabled true|false]" };
  }
  if (!SERVER_ID_PATTERN.test(serverId)) {
    return { error: `Invalid server id "${serverId}"` };
  }
  const transport = String(transportRaw ?? "").toLowerCase();
  if (!MCP_TRANSPORTS.includes(transport)) {
    return { error: `transport must be one of: ${MCP_TRANSPORTS.join(", ")}` };
  }
  const config = { transport };
  const headers = {};
  let scope = "workspace";
  const tokens = rest.slice();
  let i = 0;
  const next = () => { i += 1; return tokens[i]; };
  while (i < tokens.length) {
    const flag = tokens[i];
    if (flag === "--command") {
      config.command = next();
    } else if (flag === "--args") {
      i += 1;
      const list = [];
      while (i < tokens.length && !tokens[i].startsWith("--")) { list.push(tokens[i]); i += 1; }
      config.args = list;
      continue;
    } else if (flag === "--base-url") {
      config.baseUrl = next();
    } else if (flag === "--header") {
      const kv = next();
      const idx = kv.indexOf("=");
      if (idx === -1) return { error: `--header expects key=value, got "${kv}"` };
      headers[kv.slice(0, idx).trim()] = kv.slice(idx + 1);
    } else if (flag === "--scope") {
      scope = next();
    } else if (flag === "--enabled") {
      config.enabled = next() !== "false";
    } else {
      return { error: `Unknown option "${flag}"` };
    }
    i += 1;
  }
  if (Object.keys(headers).length > 0) config.headers = headers;
  const errors = validateMcpServerConfig(serverId, config);
  if (errors.length > 0) return { error: errors.join("; ") };
  return { serverId, transport, config, scope };
}

/**
 * Persist a new/updated server to the settings file, refresh the in-memory
 * settings and reconnect the session's MCP tools so the change is live.
 */
export async function addMcpServer({ session, cwd, scope = "workspace", serverId, config }) {
  const errors = validateMcpServerConfig(serverId, config);
  if (errors.length > 0) return { ok: false, serverId, errors };
  const written = await setSetting({ cwd, scope, key: `mcpServers.${serverId}`, value: JSON.stringify(config) });
  if (session?.settings) {
    session.settings.mcpServers = { ...(session.settings.mcpServers ?? {}), [serverId]: config };
  }
  await session?.reconnectMcpTools?.();
  return { ok: true, serverId, path: written.path, scope };
}

/**
 * Remove a server from the settings file (deleting the key), refresh the
 * in-memory settings and reconnect.
 */
export async function removeMcpServer({ session, cwd, scope = "workspace", serverId }) {
  const existed = session?.settings?.mcpServers?.[serverId] != null;
  if (!existed) return { ok: false, existed: false, serverId, error: `MCP server "${serverId}" is not configured` };
  const path = await deleteSettingKey({ cwd, scope, key: `mcpServers.${serverId}` });
  if (session?.settings) {
    const next = { ...(session.settings.mcpServers ?? {}) };
    delete next[serverId];
    session.settings.mcpServers = next;
  }
  await session?.reconnectMcpTools?.();
  return { ok: true, existed: true, serverId, path };
}

async function deleteSettingKey({ cwd, scope, key }) {
  const filePath = getSettingsPath({ cwd, scope });
  const settings = await readScopedSettings({ cwd, scope });
  deleteByPath(settings, key);
  if (Object.keys(settings.mcpServers ?? {}).length === 0) delete settings.mcpServers;
  await writeScopedSettings({ cwd, scope }, settings);
  return filePath;
}

function deleteByPath(target, key) {
  const parts = key.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (current?.[part] == null) return;
    current = current[part];
  }
  if (current) delete current[parts.at(-1)];
}
