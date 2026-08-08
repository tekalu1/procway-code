import { McpClient, discoverMcpServer } from "./client.mjs";
import { StdioMcpTransport } from "./transports/stdio.mjs";
import { HttpMcpTransport } from "./transports/http.mjs";
import { StreamableHttpMcpTransport } from "./transports/streamable-http.mjs";

/**
 * McpToolRegistry manages MCP server connections and exposes their tools
 * as callable entries integrated with the internal tool system.
 *
 * Phase 6: adds the `http` transport, `${env:VAR}` expansion in headers / urls
 * (see `expandEnvReferences`), and forwards a custom `fetchImpl` for tests.
 *
 * Lifecycle:
 *   const registry = new McpToolRegistry({ settings, cwd });
 *   await registry.start();           // connect all configured servers
 *   registry.getToolDefinitions();    // get tool defs for provider
 *   await registry.callTool(serverId, toolName, args);  // execute
 *   await registry.close();           // disconnect all servers
 */
export class McpToolRegistry {
  constructor({
    settings,
    cwd = process.cwd(),
    env = process.env,
    fetchImpl = globalThis.fetch,
    transportFactory = null,
    logger = null
  } = {}) {
    this.servers = new Map(); // serverId -> { client, tools, resources, prompts }
    this.settings = settings;
    this.cwd = cwd;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.transportFactory = transportFactory ?? defaultTransportFactory({ cwd, env, fetchImpl });
    this.logger = logger;
  }

  async start() {
    for (const [id, rawServer] of Object.entries(this.settings?.mcpServers ?? {})) {
      if (rawServer?.enabled === false) continue;
      const server = expandEnvReferences(rawServer, this.env);
      try {
        const transport = this.transportFactory(server, id);
        const client = new McpClient({ transport, timeoutMs: server.timeoutMs ?? 30000 });
        await client.start();
        const discovered = await discoverMcpServer(client);
        this.servers.set(id, { client, ...discovered });
      } catch (error) {
        this.logger?.error?.(`[mcp] Failed to start server "${id}": ${error.message}`);
      }
    }
    return this;
  }

  async close() {
    const results = [];
    for (const [id, entry] of this.servers.entries()) {
      try {
        await entry.client.close();
        results.push({ serverId: id, closed: true });
      } catch (error) {
        results.push({ serverId: id, closed: false, error: error.message });
      }
    }
    this.servers.clear();
    return results;
  }

  getToolDefinitions() {
    const defs = [];
    for (const [serverId, entry] of this.servers.entries()) {
      for (const tool of entry.tools ?? []) {
        const prefixedName = `mcp__${serverId}__${tool.name}`;
        defs.push({
          type: "function",
          function: {
            name: prefixedName,
            description: `[MCP ${serverId}] ${tool.description ?? ""}`,
            input_schema: tool.inputSchema ?? tool.parameters ?? {},
            parameters: tool.inputSchema ?? tool.parameters ?? {}
          }
        });
      }
    }
    return defs;
  }

  isMcpTool(name) {
    return name.startsWith("mcp__");
  }

  async callTool(name, args) {
    const parts = name.split("__");
    if (parts.length < 3) {
      throw new Error(`Invalid MCP tool name format: ${name}. Expected mcp__<serverId>__<toolName>`);
    }
    const serverId = parts[1];
    const toolName = parts.slice(2).join("__");
    const entry = this.servers.get(serverId);
    if (!entry) {
      throw new Error(`MCP server not found: ${serverId}. Available: ${[...this.servers.keys()].join(", ")}`);
    }
    const result = await entry.client.request("tools/call", {
      name: toolName,
      arguments: args ?? {}
    });
    return result;
  }
}

function defaultTransportFactory({ cwd, env, fetchImpl }) {
  return (server) => {
    const transport = (server?.transport ?? "stdio").toLowerCase();
    if (transport === "http" || transport === "sse") {
      // "sse" pins the legacy HTTP+SSE transport. "http" with an explicit
      // `oauth` block also stays legacy (that config predates Streamable
      // HTTP and its token grant lives in that transport). Everything else
      // on "http" gets Streamable HTTP with automatic legacy fallback.
      if (transport === "sse" || server.oauth) {
        return new HttpMcpTransport({
          baseUrl: server.baseUrl,
          headers: server.headers ?? {},
          oauth: server.oauth ?? null,
          authProvider: server.authProvider ?? null,
          fetchImpl
        });
      }
      return new StreamableHttpMcpTransport({
        baseUrl: server.baseUrl,
        headers: server.headers ?? {},
        authProvider: server.authProvider ?? null,
        fetchImpl
      });
    }
    return new StdioMcpTransport({
      command: server.command,
      args: server.args ?? [],
      cwd,
      env: server.env ? { ...env, ...server.env } : env
    });
  };
}

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Recursively replace `${env:VAR}` references inside string values. Future
 * TK-124 (procway secret store) is expected to extend this with `${secret:...}`
 * lookups; for Phase 6 we only support env vars.
 */
export function expandEnvReferences(value, env = process.env) {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (_, name) => {
      const replacement = env?.[name];
      return typeof replacement === "string" ? replacement : "";
    });
  }
  if (Array.isArray(value)) return value.map((entry) => expandEnvReferences(entry, env));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = expandEnvReferences(child, env);
    }
    return out;
  }
  return value;
}

