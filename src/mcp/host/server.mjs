/**
 * MCP host server — thin protocol adapter that exposes procway's existing
 * tool registry as an MCP server. Sub-CLIs (codex / claude code) connect as
 * MCP clients and call procway tools instead of their built-in mutations.
 *
 * Design constraints (TK-135 PoC):
 * - Pure protocol adapter: NO tool logic lives here. All execution delegates
 *   to the caller-supplied `executeToolCall` (which is `tools/registry.mjs`'s
 *   `executeToolCall` for production callers). When this PoC is removed,
 *   deleting `ai-agent/src/mcp/host/` cleanly removes everything.
 * - Transport-agnostic: returns a plain `handleMessage(msg)` function.
 *   Transports (unix socket, stdio, etc.) wire stdin/stdout/sockets to it.
 *
 * Protocol: MCP 2025-06-18, JSON-RPC 2.0. Implements the minimum subset
 * needed for sub-CLIs to discover and call tools:
 *   - initialize / notifications/initialized
 *   - tools/list
 *   - tools/call
 * (resources/* and prompts/* are not implemented; sub-CLIs degrade gracefully.)
 */

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Build a stateless MCP host server.
 *
 * @param {object} opts
 * @param {{name:string, version:string}} opts.serverInfo
 * @param {Array} opts.toolDefinitions — output of `getToolDefinitions()` from
 *   `tools/registry.mjs`. OpenAI-style `{type:"function", function:{name,description,parameters}}`.
 * @param {(name:string, args:object) => Promise<object>} opts.executeToolCall
 *   Async dispatcher. Receives MCP `tools/call` arguments, returns a
 *   procway-shape ToolResult (`{kind, summary, data}`).
 * @param {string} [opts.toolNamePrefix] — Optional prefix to namespace tools.
 *   When set (e.g. `"procway"`), tools are exposed as `procway/write_file`
 *   and the prefix is stripped on dispatch. Default: no prefix.
 */
export function createMcpHostServer({ serverInfo, toolDefinitions, executeToolCall, toolNamePrefix = "" }) {
  if (!serverInfo?.name) throw new Error("serverInfo.name is required");
  if (!Array.isArray(toolDefinitions)) throw new Error("toolDefinitions must be an array");
  if (typeof executeToolCall !== "function") throw new Error("executeToolCall must be a function");

  const exposedTools = toolDefinitions.map((def) => openAiToolToMcpTool(def, toolNamePrefix));

  async function handleMessage(message) {
    // Notifications have no `id` and expect no response.
    const isNotification = !Object.prototype.hasOwnProperty.call(message ?? {}, "id");
    try {
      const result = await dispatch(message);
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: message.id, result };
    } catch (err) {
      if (isNotification) return null;
      const code = typeof err?.code === "number" ? err.code : -32603;
      return {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code, message: err?.message ?? "Internal error" }
      };
    }
  }

  async function dispatch(message) {
    if (!message || typeof message !== "object") throw rpcError(-32600, "Invalid Request");
    if (message.jsonrpc !== "2.0") throw rpcError(-32600, "Invalid Request: jsonrpc must be '2.0'");
    const method = message.method;

    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo
        };

      case "notifications/initialized":
      case "initialized":
        // Client signaling completion of handshake. No response.
        return null;

      case "tools/list":
        return { tools: exposedTools };

      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        if (typeof name !== "string" || !name) throw rpcError(-32602, "Invalid params: name is required");
        const internalName = stripPrefix(name, toolNamePrefix);
        const known = exposedTools.find((t) => t.name === name);
        if (!known) throw rpcError(-32602, `Unknown tool: ${name}`);

        const toolResult = await executeToolCall(internalName, args);
        return mcpContentFromToolResult(toolResult);
      }

      // Optional methods clients may probe for. Return empty lists rather
      // than -32601 so sub-CLIs don't log scary errors.
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };

      default:
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  return { handleMessage };
}

function openAiToolToMcpTool(def, prefix) {
  const fn = def?.function ?? {};
  const baseName = fn.name ?? "";
  const name = prefix ? `${prefix}/${baseName}` : baseName;
  return {
    name,
    description: fn.description ?? "",
    inputSchema: fn.parameters ?? { type: "object", properties: {}, required: [] }
  };
}

function stripPrefix(name, prefix) {
  if (!prefix) return name;
  const head = `${prefix}/`;
  return name.startsWith(head) ? name.slice(head.length) : name;
}

/**
 * Convert a procway ToolResult ({kind, summary, data}) to MCP tool/call
 * response shape. MCP expects `content: [{type:"text", text}]` plus an
 * `isError` flag. Errors and "skipped" results both flow through as
 * isError=true so sub-CLIs back off, while success is plain text.
 */
function mcpContentFromToolResult(result) {
  if (result == null) {
    return { content: [{ type: "text", text: "" }], isError: false };
  }
  const summary = typeof result.summary === "string" ? result.summary : "";
  const dataText = result.data != null ? safeJson(result.data) : "";
  const text = dataText ? `${summary}\n\n${dataText}` : summary;
  const isError = Boolean(result?.data?.error || result?.data?.skipped);
  return {
    content: [{ type: "text", text: text || "(no output)" }],
    isError
  };
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function rpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
