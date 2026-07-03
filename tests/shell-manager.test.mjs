import { describe, expect, it, afterEach } from "vitest";
import { ShellManager } from "../src/tools/shell-manager.mjs";
import { runShellKill, runShellLogs, runShellStatus, runShell } from "../src/tools/shell.mjs";

const managers = [];

afterEach(async () => {
  while (managers.length > 0) {
    const manager = managers.pop();
    await manager.closeAll({ graceMs: 500 }).catch(() => {});
  }
});

function makeManager() {
  const manager = new ShellManager();
  managers.push(manager);
  return manager;
}

async function waitUntil(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitUntil: timeout");
}

describe("ShellManager", () => {
  it("starts a background command, captures stdout, and reports exit", async () => {
    const manager = makeManager();
    const command = process.platform === "win32"
      ? `node -e "console.log('hello-bg'); setTimeout(()=>{}, 50)"`
      : `node -e "console.log('hello-bg'); setTimeout(()=>{}, 50)"`;
    const { shellId } = manager.start({ command });
    expect(typeof shellId).toBe("string");

    await waitUntil(() => manager.status(shellId).status === "exited");
    const status = manager.status(shellId);
    expect(status.exitCode).toBe(0);
    const logs = manager.logs(shellId);
    expect(logs.stdout).toContain("hello-bg");
  });

  it("kills a still-running shell on demand", async () => {
    const manager = makeManager();
    const command = `node -e "setInterval(()=>{}, 1000)"`;
    const { shellId } = manager.start({ command });
    expect(manager.status(shellId).status).toBe("running");
    await manager.kill(shellId, { signal: "SIGTERM", graceMs: 800 });
    await waitUntil(() => manager.status(shellId).status === "exited");
    expect(manager.status(shellId).status).toBe("exited");
  });

  it("returns ToolResults via runShell{Status,Logs,Kill} helpers", async () => {
    const manager = makeManager();
    const cmd = `node -e "console.log('via-tool'); setTimeout(()=>{}, 100)"`;
    const start = await runShell({ command: cmd, runInBackground: true, shellManager: manager });
    expect(start.kind).toBe("run_shell");
    const shellId = start.data.shellId;
    expect(typeof shellId).toBe("string");

    const status = await runShellStatus({ shellId, shellManager: manager });
    expect(status.data.status).toBeDefined();

    // ADR 0029 P2: shellId is now the registry jobId, not the ShellManager's
    // internal id — poll exit via the registry-backed status helper.
    await waitUntil(async () => (await runShellStatus({ shellId, shellManager: manager })).data.status === "exited");

    const logs = await runShellLogs({ shellId, shellManager: manager });
    expect(logs.data.stdout).toContain("via-tool");

    const kill = await runShellKill({ shellId, shellManager: manager });
    expect(kill.data.alreadyExited).toBe(true);
  });

  it("returns an error result when shellId is unknown", async () => {
    const manager = makeManager();
    const status = await runShellStatus({ shellId: "missing", shellManager: manager });
    expect(status.data.error).toBe("shellId not found");
  });
});
