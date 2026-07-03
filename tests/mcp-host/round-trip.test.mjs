/**
 * Round-trip integration: spawn the host CLI as a child process and drive it
 * via stdio JSON-RPC, the same way codex/claude-code would. Verifies the
 * full pipeline: stdio framing → server dispatch → tools/registry execution.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_CLI = path.resolve(__dirname, "../../src/mcp/host/cli.mjs");

class StdioClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", () => {}); // discard
  }
  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch { /* ignore */ }
    }
  }
  request(method, params = {}) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  close() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

describe("MCP host round-trip via stdio", () => {
  let workDir;
  let child;
  let client;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "procway-mcp-rt-"));
    child = spawn(process.execPath, [HOST_CLI, "--cwd", workDir, "--prefix", "procway"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    client = new StdioClient(child);
    // Initialize handshake.
    const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.serverInfo.name).toBe("procway-mcp-host");
    client.notify("notifications/initialized");
  }, 15000);

  afterAll(() => {
    client?.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("lists tools with the procway/ namespace prefix", async () => {
    const res = await client.request("tools/list");
    expect(Array.isArray(res.result.tools)).toBe(true);
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain("procway/write_file");
    expect(names).toContain("procway/read_file");
  });

  it("executes a real write_file via tools/call and produces the file on disk", async () => {
    const res = await client.request("tools/call", {
      name: "procway/write_file",
      arguments: { filePath: "hello.txt", content: "hi from MCP" }
    });
    expect(res.result.isError).toBe(false);
    const written = fs.readFileSync(path.join(workDir, "hello.txt"), "utf8");
    expect(written).toBe("hi from MCP");
  });

  it("returns -32602 for unknown tool", async () => {
    const res = await client.request("tools/call", { name: "procway/no_such", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });
});
