import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/agent/conversation.mjs";
import {
  mcpListCommand,
  addMcpServer,
  removeMcpServer,
  parseMcpAddArgs,
  validateMcpServerConfig,
  MCP_TRANSPORTS
} from "../src/core/commands/mcp.mjs";

const echoFixture = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));

function baseSettings() {
  return {
    defaultProvider: "echo-agent",
    defaultModel: "echo",
    approvalMode: "auto-readonly",
    agents: { defaultTimeoutMs: 5000, maxDepth: 1, maxConcurrentAgents: 1 },
    tools: { maxToolRounds: 1, maxParallelTools: 1 },
    providers: { "echo-agent": { type: "cli-agent", command: process.execPath, args: [echoFixture], stdinMode: "json" } },
    mcpServers: {},
    session: { enabled: true }
  };
}

function fakeRegistry({ connected = true, tools = [] } = {}) {
  const servers = new Map();
  if (connected) servers.set("demo", { tools: tools.length ? tools : [{ name: "echo" }] });
  return {
    settings: { mcpServers: { demo: { transport: "stdio", command: "node" } } },
    servers,
    serversMap: servers
  };
}

describe("parseMcpAddArgs", () => {
  it("parses a stdio server with command and args", () => {
    const out = parseMcpAddArgs(["demo", "stdio", "--command", "node", "--args", "a", "b"]);
    expect(out.error).toBeUndefined();
    expect(out.serverId).toBe("demo");
    expect(out.transport).toBe("stdio");
    expect(out.config).toEqual({ transport: "stdio", command: "node", args: ["a", "b"] });
    expect(out.scope).toBe("workspace");
  });

  it("parses an http server with base-url and headers", () => {
    const out = parseMcpAddArgs(["remote", "http", "--base-url", "http://localhost:9000", "--header", "Authorization=Bearer x", "--scope", "user"]);
    expect(out.error).toBeUndefined();
    expect(out.config).toEqual({
      transport: "http",
      baseUrl: "http://localhost:9000",
      headers: { Authorization: "Bearer x" }
    });
    expect(out.scope).toBe("user");
  });

  it("rejects a missing id and a bad transport", () => {
    expect(parseMcpAddArgs([]).error).toMatch(/^Usage:/);
    expect(parseMcpAddArgs(["demo", "bogus"]).error).toMatch(/transport must be one of/);
    expect(parseMcpAddArgs(["bad id!", "stdio"]).error).toMatch(/Invalid server id/);
  });

  it("rejects an unknown option and a stdio server without a command", () => {
    expect(parseMcpAddArgs(["demo", "stdio", "--wat"]).error).toMatch(/Unknown option/);
    expect(parseMcpAddArgs(["demo", "stdio"]).error).toMatch(/command is required/);
  });

  it("MCP_TRANSPORTS is an immutable list", () => {
    expect([...MCP_TRANSPORTS]).toEqual(["stdio", "http", "sse"]);
  });
});

describe("validateMcpServerConfig", () => {
  it("accepts a well-formed stdio and http config", () => {
    expect(validateMcpServerConfig("demo", { transport: "stdio", command: "node" })).toEqual([]);
    expect(validateMcpServerConfig("remote", { transport: "http", baseUrl: "http://x" })).toEqual([]);
  });
  it("returns schema errors for missing fields", () => {
    expect(validateMcpServerConfig("demo", { transport: "stdio" }).join(";")).toMatch(/command is required/);
    expect(validateMcpServerConfig("demo", { transport: "http" }).join(";")).toMatch(/baseUrl is required/);
  });
});

describe("mcpListCommand", () => {
  it("reports connected status and tools and ignores nothing", async () => {
    const result = await mcpListCommand({ session: { mcpRegistry: fakeRegistry() } });
    expect(result.connected).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.servers[0]).toMatchObject({ id: "demo", transport: "stdio", status: "connected", toolCount: 1 });
    expect(result.servers[0].tools).toEqual(["echo"]);
  });
  it("marks a configured-but-not-connected server as failed", async () => {
    const result = await mcpListCommand({ session: { mcpRegistry: fakeRegistry({ connected: false }) } });
    expect(result.failed).toBe(1);
    expect(result.servers[0].status).toBe("failed");
    expect(result.servers[0].toolCount).toBe(0);
  });
});

describe("addMcpServer / removeMcpServer persistence", () => {
  let cwd;
  beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "procway-mcp-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  function fakeSession() {
    return { settings: { ...baseSettings() }, reconnectMcpTools: vi.fn(async () => {}) };
  }

  it("persists a server to the workspace settings file and refreshes in-memory settings", async () => {
    const session = fakeSession();
    const result = await addMcpServer({ session, cwd, serverId: "demo", config: { transport: "stdio", command: "node", args: ["a.js"] } });
    expect(result.ok).toBe(true);
    expect(session.settings.mcpServers.demo).toEqual({ transport: "stdio", command: "node", args: ["a.js"] });
    expect(session.reconnectMcpTools).toHaveBeenCalledOnce();

    const file = JSON.parse(await readFile(path.join(cwd, ".procway", "ai-agent", "settings.json"), "utf8"));
    expect(file.mcpServers.demo).toEqual({ transport: "stdio", command: "node", args: ["a.js"] });
  });

  it("does not persist an invalid server and does not reconnect", async () => {
    const session = fakeSession();
    const result = await addMcpServer({ session, cwd, serverId: "demo", config: { transport: "stdio" } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(";")).toMatch(/command is required/);
    expect(session.reconnectMcpTools).not.toHaveBeenCalled();
  });

  it("removes a server, deletes the key and reconnects", async () => {
    const session = fakeSession();
    session.settings.mcpServers = { demo: { transport: "stdio", command: "node" } };
    const added = await addMcpServer({ session, cwd, serverId: "demo", config: { transport: "stdio", command: "node" } });
    expect(added.ok).toBe(true);
    session.reconnectMcpTools.mockClear();

    const removed = await removeMcpServer({ session, cwd, serverId: "demo" });
    expect(removed.ok).toBe(true);
    expect(session.settings.mcpServers.demo).toBeUndefined();
    expect(session.reconnectMcpTools).toHaveBeenCalledOnce();

    const file = JSON.parse(await readFile(path.join(cwd, ".procway", "ai-agent", "settings.json"), "utf8"));
    expect(file.mcpServers ?? {}).toEqual({});
  });

  it("reports an error when removing a server that is not configured", async () => {
    const session = fakeSession();
    const result = await removeMcpServer({ session, cwd, serverId: "nope" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/is not configured/);
    expect(session.reconnectMcpTools).not.toHaveBeenCalled();
  });
});

describe("AgentSession.reconnectMcpTools", () => {
  let cwd;
  let session;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "procway-mcp-reconnect-"));
  });
  afterEach(async () => {
    await session?.reconnectMcpTools().catch(() => {});
    await session?.mcpRegistry?.close?.().catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  });

  it("reloads tools from a live stdio MCP server on reconnect", async () => {
    const settings = baseSettings();
    settings.mcpServers = { demo: { transport: "stdio", command: process.execPath, args: [echoFixture] } };
    session = await new AgentSession({ settings, cwd, sessionId: "mcp-r1", events: undefined }).initialize();

    const hasDemo = (s) => s.tools.some((tool) => tool.function.name === "mcp__demo__echo");
    expect(hasDemo(session)).toBe(true);

    // Add a second server to in-memory settings, then reconnect.
    session.settings.mcpServers.other = { transport: "stdio", command: process.execPath, args: [echoFixture] };
    await session.reconnectMcpTools();

    expect(hasDemo(session)).toBe(true);
    expect(session.tools.some((tool) => tool.function.name === "mcp__other__echo")).toBe(true);

    // Removing it and reconnecting drops the tool.
    delete session.settings.mcpServers.other;
    await session.reconnectMcpTools();
    expect(session.tools.some((tool) => tool.function.name === "mcp__other__echo")).toBe(false);
    expect(hasDemo(session)).toBe(true);
  });
});
