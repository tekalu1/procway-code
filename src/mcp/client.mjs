export class McpClient {
  constructor({ transport, clientInfo = { name: "procway-code", version: "0.0.0" }, timeoutMs = 30000 }) {
    this.transport = transport;
    this.clientInfo = clientInfo;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.transport.onmessage = (message) => this.handleMessage(message);
    this.transport.onerror = (error) => this.rejectAll(error);
    this.transport.onclose = () => this.rejectAll(new Error("MCP transport closed"));
  }

  async start() {
    await this.transport.start();
    return this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: this.clientInfo
    });
  }

  async close() {
    await this.transport.close?.();
  }

  async request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.transport.send(message);
    return promise;
  }

  async listTools() {
    const result = await this.request("tools/list");
    return result.tools ?? [];
  }

  async listResources() {
    const result = await this.request("resources/list");
    return result.resources ?? [];
  }

  async listPrompts() {
    const result = await this.request("prompts/list");
    return result.prompts ?? [];
  }

  handleMessage(message) {
    if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "MCP request failed"));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export async function discoverMcpServer(client) {
  const [tools, resources, prompts] = await Promise.all([
    client.listTools().catch(() => []),
    client.listResources().catch(() => []),
    client.listPrompts().catch(() => [])
  ]);
  return { tools, resources, prompts };
}
