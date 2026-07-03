import { describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeToolCall, getToolDefinitions, isMutationTool } from "../src/tools/registry.mjs";
import { getDesktopActionAvailability, resolveWorkspacePath, runDesktopAction } from "../src/tools/desktop.mjs";

// ADR 0030 D5: registration filters by real-environment availability, so
// presence assertions inject "everything available" to stay host-independent.
const ALL_AVAILABLE = { web_browser: { available: true }, desktop_action: { available: true } };

describe("desktop tools", () => {
  it("exposes desktop_action through the registry as a mutation-capable tool", () => {
    const def = getToolDefinitions({ availability: ALL_AVAILABLE }).find((tool) => tool.function.name === "desktop_action");
    expect(def).toBeTruthy();
    expect(def.function.parameters.required).toContain("steps");
    expect(isMutationTool("desktop_action")).toBe(true);
  });

  it("dispatches desktop_action through approval gate and helper", async () => {
    const approvalRequester = vi.fn(async () => true);
    const desktopActionRunner = vi.fn(async () => ({
      kind: "desktop_action",
      summary: "ok",
      data: { steps: [], display: ":1" }
    }));
    const steps = [{ action: "screenshot", path: "tmp/shot.png" }];

    const result = await executeToolCall({
      name: "desktop_action",
      args: { steps },
      cwd: process.cwd(),
      settings: { approvalMode: "auto-readonly", tools: {} },
      approvalRequester,
      desktopActionRunner
    });

    expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({
      kind: "desktop_action",
      // screenshot-only is read-only
      mutation: false,
      payload: { steps }
    }));
    expect(desktopActionRunner).toHaveBeenCalledWith(expect.objectContaining({ cwd: process.cwd(), steps }));
    expect(result.kind).toBe("desktop_action");
  });

  it("marks mouse/keyboard steps as mutations for approval", async () => {
    const approvalRequester = vi.fn(async () => false);
    const desktopActionRunner = vi.fn();
    const steps = [{ action: "mouse_click", x: 10, y: 20 }];

    const result = await executeToolCall({
      name: "desktop_action",
      args: { steps },
      cwd: process.cwd(),
      settings: { approvalMode: "always-ask", tools: {} },
      approvalRequester,
      desktopActionRunner
    });

    expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop_action", mutation: true }));
    expect(desktopActionRunner).not.toHaveBeenCalled();
    expect(result.data.skipped).toBe(true);
  });

  it("rejects screenshot paths outside the workspace", () => {
    expect(() => resolveWorkspacePath(process.cwd(), "../outside.png")).toThrow(/inside the workspace/);
    expect(() => resolveWorkspacePath(process.cwd(), "/tmp/outside.png")).toThrow(/workspace-relative/);
  });

  it("runs screenshot/mouse/type/key steps through injected command runner", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-desktop-"));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    try {
      const result = await runDesktopAction({
        cwd,
        runCommand,
        display: ":99",
        steps: [
          { action: "screenshot", path: "evidence/desk.png" },
          { action: "mouse_move", x: 120, y: 240 },
          { action: "mouse_click", x: 120, y: 240, button: "right" },
          { action: "type", text: "hello", delayMs: 5 },
          { action: "key", keys: "ctrl+a Delete" }
        ]
      });

      expect(runCommand).toHaveBeenNthCalledWith(
        1,
        "scrot",
        ["--overwrite", path.join(cwd, "evidence/desk.png")],
        expect.objectContaining({ env: expect.objectContaining({ DISPLAY: ":99" }) })
      );
      expect(runCommand).toHaveBeenNthCalledWith(2, "xdotool", ["mousemove", "--sync", "120", "240"], expect.anything());
      expect(runCommand).toHaveBeenNthCalledWith(3, "xdotool", ["mousemove", "--sync", "120", "240", "click", "3"], expect.anything());
      expect(runCommand).toHaveBeenNthCalledWith(4, "xdotool", ["type", "--delay", "5", "--", "hello"], expect.anything());
      expect(runCommand).toHaveBeenNthCalledWith(5, "xdotool", ["key", "--", "ctrl+a", "Delete"], expect.anything());

      expect(result.data.steps.map((step) => step.action)).toEqual([
        "screenshot", "mouse_move", "mouse_click", "type", "key"
      ]);
      expect(result.data.display).toBe(":99");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown action strings with a clear error", async () => {
    await expect(runDesktopAction({
      cwd: process.cwd(),
      runCommand: vi.fn(),
      steps: [{ action: "evil_action" }]
    })).rejects.toThrow(/Unsupported desktop action/);
  });

  it("validates required step fields", async () => {
    await expect(runDesktopAction({
      cwd: process.cwd(),
      runCommand: vi.fn(),
      steps: [{ action: "mouse_move" }]
    })).rejects.toThrow(/x must be an integer/);

    await expect(runDesktopAction({
      cwd: process.cwd(),
      runCommand: vi.fn(),
      steps: [{ action: "type" }]
    })).rejects.toThrow(/text must be a non-empty string/);

    await expect(runDesktopAction({
      cwd: process.cwd(),
      runCommand: vi.fn(),
      steps: [{ action: "key" }]
    })).rejects.toThrow(/keys must be a non-empty string/);
  });
});

describe("desktop_action availability (ADR 0030 D5)", () => {
  const env = (overrides = {}) => ({ PATH: "/usr/bin", DISPLAY: ":1", ...overrides });

  it("is available when xdotool + scrot are on PATH and DISPLAY is exported", () => {
    const findBinary = vi.fn(() => true);
    expect(getDesktopActionAvailability({ env: env(), findBinary })).toEqual({ available: true });
    expect(findBinary).toHaveBeenCalledWith("xdotool", expect.anything());
    expect(findBinary).toHaveBeenCalledWith("scrot", expect.anything());
  });

  it("names each missing binary in the reason", () => {
    const findBinary = vi.fn((binary) => binary !== "scrot");
    expect(getDesktopActionAvailability({ env: env(), findBinary })).toEqual({
      available: false,
      reason: "missing binary scrot"
    });
    expect(getDesktopActionAvailability({ env: env(), findBinary: () => false })).toEqual({
      available: false,
      reason: "missing binary xdotool, missing binary scrot"
    });
  });

  it("requires DISPLAY to be exported — no implicit :1 counts as available", () => {
    expect(getDesktopActionAvailability({ env: env({ DISPLAY: undefined }), findBinary: () => true })).toEqual({
      available: false,
      reason: "DISPLAY unset"
    });
  });

  it("default probe (no injected findBinary): executable file yes; non-executable file / directory no", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "procway-desktop-avail-"));
    try {
      const binDir = path.join(dir, "bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, "xdotool"), "#!/bin/sh\n");
      await chmod(path.join(binDir, "xdotool"), 0o755);
      await writeFile(path.join(binDir, "scrot"), "#!/bin/sh\n");
      await chmod(path.join(binDir, "scrot"), 0o755);
      const probe = (PATH) => getDesktopActionAvailability({ env: { PATH, DISPLAY: ":1" } });

      expect(probe(binDir)).toEqual({ available: true });

      // Non-executable scrot is a miss, not a hit
      await chmod(path.join(binDir, "scrot"), 0o644);
      expect(probe(binDir)).toEqual({ available: false, reason: "missing binary scrot" });

      // A DIRECTORY named like the binary must not count (accessSync X_OK
      // succeeds on directories — the probe requires a regular file).
      const shadowDir = path.join(dir, "shadow");
      await mkdir(path.join(shadowDir, "xdotool"), { recursive: true });
      await mkdir(path.join(shadowDir, "scrot"), { recursive: true });
      expect(probe(shadowDir)).toEqual({
        available: false,
        reason: "missing binary xdotool, missing binary scrot"
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
