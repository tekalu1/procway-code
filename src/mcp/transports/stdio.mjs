import { spawn } from "node:child_process";

export class StdioMcpTransport {
  constructor({ command, args = [], cwd = process.cwd(), env = process.env }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.process = null;
    this.buffer = "";
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  async start() {
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.process.stdout.on("data", (chunk) => this.handleStdout(chunk.toString("utf8")));
    this.process.stderr.on("data", () => {});
    this.process.on("error", (error) => this.onerror?.(error));
    this.process.on("close", () => this.onclose?.());
  }

  async send(message) {
    if (!this.process?.stdin) throw new Error("MCP stdio transport is not started");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    this.process?.kill("SIGTERM");
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        this.onmessage?.(JSON.parse(line));
      } catch (error) {
        this.onerror?.(error);
      }
    }
  }
}
