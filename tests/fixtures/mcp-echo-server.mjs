#!/usr/bin/env node
/**
 * Minimal newline-delimited JSON-RPC MCP server over stdio for tests.
 *
 * Speaks just enough of the MCP protocol for `McpClient`/`StdioMcpTransport`:
 *   initialize → tools/list → resources/list → prompts/list → tools/call.
 * It exposes one tool, `echo`, whose text argument is echoed back.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

rl.on("line", (raw) => {
  if (!raw.trim()) return;
  let message;
  try { message = JSON.parse(raw); }
  catch { return; }

  // Notifications carry no id — acknowledge nothing.
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  const { id, method, params } = message;

  let result;
  switch (method) {
    case "initialize":
      result = {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-echo", version: "1.0.0" }
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: [{ name: "echo", description: "Echo the input text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
      break;
    case "tools/call":
      result = { content: [{ type: "text", text: params?.arguments?.text ?? "" }] };
      break;
    case "resources/list":
      result = { resources: [] };
      break;
    case "prompts/list":
      result = { prompts: [] };
      break;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
  }
  send({ jsonrpc: "2.0", id, result });
});
