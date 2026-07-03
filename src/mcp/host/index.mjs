/**
 * Public entry point for the MCP host adapter. PoC scope (TK-135) — the entire
 * `ai-agent/src/mcp/host/` directory is removable in one PR when this PoC is
 * retired (book-keeping for that lives in the matching ADR).
 */

export { createMcpHostServer } from "./server.mjs";
export { runStdioTransport } from "./stdio-transport.mjs";
export { buildMcpInjection } from "./inject-config.mjs";
