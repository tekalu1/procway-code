import { describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeToolCall, getToolDefinitions, isMutationTool } from "../src/tools/registry.mjs";
import { getWebBrowserAvailability, resolveWorkspacePath, runWebBrowserAction, isWebBrowserMutationStep } from "../src/tools/web-browser.mjs";

// ADR 0030 D5: registration filters by real-environment availability, so
// presence assertions inject "everything available" to stay host-independent.
const ALL_AVAILABLE = { web_browser: { available: true }, desktop_action: { available: true } };

// Fake agent-browser CLI: returns the {success,data,error} JSON envelope on
// stdout (as the real binary does under AGENT_BROWSER_JSON), keyed by the
// subcommand in args[0..1]. Records every invocation for argv assertions.
function makeFakeCli(calls) {
  return vi.fn(async (command, args, { env } = {}) => {
    calls.push({ command, args, env });
    const head = `${args[0]} ${args[1] ?? ""}`.trim();
    let data = {};
    if (args[0] === "open") data = { title: "Example Domain", url: "https://example.test/" };
    else if (args[0] === "snapshot") data = { snapshot: '- link "Learn" [ref=e2]', refs: { e2: { name: "Learn", role: "link" } } };
    else if (args[0] === "click") data = { clicked: args[1] };
    else if (head === "get text") data = { text: "hello world" };
    else if (args[0] === "screenshot") data = { path: args[1] };
    return { stdout: JSON.stringify({ success: true, data, error: null }), stderr: "", code: 0 };
  });
}

describe("web_browser tool", () => {
  it("exposes web_browser through the registry as a mutation-capable tool", () => {
    const def = getToolDefinitions({ availability: ALL_AVAILABLE }).find((tool) => tool.function.name === "web_browser");
    expect(def).toBeTruthy();
    expect(def.function.parameters.required).toContain("steps");
    expect(isMutationTool("web_browser")).toBe(true);
  });

  it("classifies read-only vs mutating steps", () => {
    expect(isWebBrowserMutationStep("snapshot")).toBe(false);
    expect(isWebBrowserMutationStep("navigate")).toBe(false);
    expect(isWebBrowserMutationStep("get_text")).toBe(false);
    expect(isWebBrowserMutationStep("screenshot")).toBe(false);
    expect(isWebBrowserMutationStep("click")).toBe(true);
    expect(isWebBrowserMutationStep("fill")).toBe(true);
    expect(isWebBrowserMutationStep("press")).toBe(true);
  });

  it("dispatches a read-only (snapshot) call through the gate with mutation:false", async () => {
    const approvalRequester = vi.fn(async () => true);
    const webBrowserActionRunner = vi.fn(async () => ({ kind: "browser_action", summary: "ok", data: { steps: [] } }));
    const steps = [{ action: "navigate", url: "https://example.test" }, { action: "snapshot" }];

    const result = await executeToolCall({
      name: "web_browser",
      args: { steps },
      cwd: process.cwd(),
      settings: { approvalMode: "auto-readonly", tools: {} },
      approvalRequester,
      webBrowserActionRunner
    });

    expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({
      kind: "browser_action",
      mutation: false,
      payload: { steps }
    }));
    expect(webBrowserActionRunner).toHaveBeenCalledWith(expect.objectContaining({ cwd: process.cwd(), steps }));
    expect(result.kind).toBe("browser_action");
  });

  it("marks click/fill steps as mutations for approval and skips when denied", async () => {
    const approvalRequester = vi.fn(async () => false);
    const webBrowserActionRunner = vi.fn();
    const steps = [{ action: "click", ref: "@e2" }];

    const result = await executeToolCall({
      name: "web_browser",
      args: { steps },
      cwd: process.cwd(),
      settings: { approvalMode: "always-ask", tools: {} },
      approvalRequester,
      webBrowserActionRunner
    });

    expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({ kind: "browser_action", mutation: true }));
    expect(webBrowserActionRunner).not.toHaveBeenCalled();
    expect(result.data.skipped).toBe(true);
  });

  it("maps steps to agent-browser argv and injects the launch env", async () => {
    const calls = [];
    const runCommand = makeFakeCli(calls);
    const result = await runWebBrowserAction({
      cwd: process.cwd(),
      runCommand,
      steps: [
        { action: "navigate", url: "https://example.test" },
        { action: "snapshot" },
        { action: "fill", ref: "@e3", text: "procway" },
        { action: "click", ref: "@e2" },
        { action: "press", keys: "Enter" },
        { action: "type", text: "hi" },
        { action: "wait", ms: 500 },
        { action: "scroll", direction: "down", px: 200 }
      ]
    });

    expect(calls.map((c) => c.args)).toEqual([
      ["open", "https://example.test"],
      ["snapshot", "-i", "-c"],
      ["fill", "@e3", "procway"],
      ["click", "@e2"],
      ["press", "Enter"],
      ["keyboard", "type", "hi"],
      ["wait", "500"],
      ["scroll", "down", "200"]
    ]);
    // Validated launch recipe (ADR 0007 Phase 0) is injected as env.
    const env = calls[0].env;
    expect(env.AGENT_BROWSER_JSON).toBe("1");
    expect(env.AGENT_BROWSER_HEADED).toBe("1");
    expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBe("/usr/bin/chromium");

    expect(result.kind).toBe("browser_action");
    expect(result.data.steps.map((s) => s.action)).toEqual([
      "navigate", "snapshot", "fill", "click", "press", "type", "wait", "scroll"
    ]);
  });

  it("returns the snapshot text + refs so the model can pick a ref", async () => {
    const runCommand = makeFakeCli([]);
    const result = await runWebBrowserAction({
      cwd: process.cwd(),
      runCommand,
      steps: [{ action: "snapshot" }]
    });
    const snap = result.data.steps[0];
    expect(snap.refs).toEqual({ e2: { name: "Learn", role: "link" } });
    expect(snap.snapshot).toContain("ref=e2");
  });

  it("get_text targets body by default and a ref/selector when given", async () => {
    const calls = [];
    const runCommand = makeFakeCli(calls);
    await runWebBrowserAction({
      cwd: process.cwd(),
      runCommand,
      steps: [
        { action: "get_text" },                 // -> body (CLI requires a target)
        { action: "get_text", ref: "@e2" },
        { action: "get_text", selector: "h1" }
      ]
    });
    expect(calls.map((c) => c.args)).toEqual([
      ["get", "text", "body"],
      ["get", "text", "@e2"],
      ["get", "text", "h1"]
    ]);
  });

  it("honors snapshot interactiveOnly:false / compact:false", async () => {
    const calls = [];
    await runWebBrowserAction({
      cwd: process.cwd(),
      runCommand: makeFakeCli(calls),
      steps: [{ action: "snapshot", interactiveOnly: false, compact: false }]
    });
    expect(calls[0].args).toEqual(["snapshot"]);
  });

  it("writes screenshots to workspace-relative paths and returns the relative path", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-web-browser-"));
    const calls = [];
    try {
      const result = await runWebBrowserAction({
        cwd,
        runCommand: makeFakeCli(calls),
        steps: [{ action: "screenshot", path: "evidence/shot.png", annotate: true }]
      });
      const absArg = calls[0].args[1];
      expect(path.isAbsolute(absArg)).toBe(true);
      // parent dir is created before invoking the CLI
      await stat(path.dirname(absArg));
      expect(result.data.steps[0]).toMatchObject({ action: "screenshot", path: path.join("evidence", "shot.png"), annotate: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects screenshot paths outside the workspace", () => {
    expect(() => resolveWorkspacePath(process.cwd(), "../outside.png")).toThrow(/inside the workspace/);
    expect(() => resolveWorkspacePath(process.cwd(), "/tmp/outside.png")).toThrow(/workspace-relative/);
  });

  it("surfaces an agent-browser failure ({success:false}) as a thrown error", async () => {
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({ success: false, data: null, error: "element @e9 not found" }),
      stderr: "",
      code: 1
    }));
    await expect(runWebBrowserAction({
      cwd: process.cwd(),
      runCommand,
      steps: [{ action: "click", ref: "@e9" }]
    })).rejects.toThrow(/element @e9 not found/);
  });
});

describe("web_browser availability (ADR 0030 D5)", () => {
  const env = (overrides = {}) => ({ PATH: "/usr/bin", DISPLAY: ":1", ...overrides });

  it("is available when agent-browser + the pinned browser executable exist and DISPLAY is exported", () => {
    const findBinary = vi.fn(() => true);
    expect(getWebBrowserAvailability({ env: env(), findBinary })).toEqual({ available: true });
    expect(findBinary).toHaveBeenCalledWith("agent-browser", expect.anything());
    // buildEnv pins AGENT_BROWSER_EXECUTABLE_PATH (default /usr/bin/chromium),
    // so chromium is probed as that resolved path, not as a PATH lookup.
    expect(findBinary).toHaveBeenCalledWith("/usr/bin/chromium", expect.anything());
  });

  it("names the missing agent-browser binary in the reason", () => {
    const findBinary = vi.fn((binary) => binary !== "agent-browser");
    expect(getWebBrowserAvailability({ env: env(), findBinary })).toEqual({
      available: false,
      reason: "missing binary agent-browser"
    });
  });

  it("probes the AGENT_BROWSER_EXECUTABLE_PATH override instead of the default chromium path", () => {
    const findBinary = vi.fn((binary) => binary !== "/usr/bin/chromium");
    const result = getWebBrowserAvailability({
      env: env({ AGENT_BROWSER_EXECUTABLE_PATH: "/opt/chrome/chrome" }),
      findBinary
    });
    expect(result).toEqual({ available: true });
    expect(findBinary).toHaveBeenCalledWith("/opt/chrome/chrome", expect.anything());
  });

  it("requires DISPLAY to be exported — no implicit :1 counts as available", () => {
    expect(getWebBrowserAvailability({ env: env({ DISPLAY: undefined }), findBinary: () => true })).toEqual({
      available: false,
      reason: "DISPLAY unset"
    });
  });

  it("honors settings.tools.browser overrides — the values buildEnv resolves at execution time", () => {
    // executablePath: settings beats env/default (buildEnv line: cfg.executablePath ?? env ?? default)
    const findBinary = vi.fn((binary) => binary === "agent-browser" || binary === "/opt/chrome/chrome");
    expect(getWebBrowserAvailability({
      env: env(),
      settings: { tools: { browser: { executablePath: "/opt/chrome/chrome" } } },
      findBinary
    })).toEqual({ available: true });
    expect(findBinary).toHaveBeenCalledWith("/opt/chrome/chrome", expect.anything());

    // binary: a renamed agent-browser is probed under its configured name
    const findRenamed = vi.fn((binary) => binary !== "agent-browser");
    expect(getWebBrowserAvailability({
      env: env(),
      settings: { tools: { browser: { binary: "my-agent-browser" } } },
      findBinary: findRenamed
    })).toEqual({ available: true });
    expect(findRenamed).toHaveBeenCalledWith("my-agent-browser", expect.anything());
  });

  it("settings.tools.browser.headed:false needs no DISPLAY; cfg.display satisfies the headed requirement", () => {
    expect(getWebBrowserAvailability({
      env: env({ DISPLAY: undefined }),
      settings: { tools: { browser: { headed: false } } },
      findBinary: () => true
    })).toEqual({ available: true });
    expect(getWebBrowserAvailability({
      env: env({ DISPLAY: undefined }),
      settings: { tools: { browser: { display: ":9" } } },
      findBinary: () => true
    })).toEqual({ available: true });
  });

  it("treats an empty AGENT_BROWSER_EXECUTABLE_PATH as missing (buildEnv would forward it as-is)", () => {
    expect(getWebBrowserAvailability({
      env: env({ AGENT_BROWSER_EXECUTABLE_PATH: "" }),
      findBinary: () => true
    })).toEqual({
      available: false,
      reason: "missing browser executable (empty)"
    });
  });

  it("default probe (no injected findBinary): executable file yes; non-executable file / directory no", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "procway-wb-avail-"));
    try {
      const binDir = path.join(dir, "bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(binDir, "agent-browser"), "#!/bin/sh\n");
      await chmod(path.join(binDir, "agent-browser"), 0o755);
      const chromium = path.join(binDir, "chromium");
      await writeFile(chromium, "#!/bin/sh\n");
      await chmod(chromium, 0o755);
      const probe = (overrides = {}) => getWebBrowserAvailability({
        env: { PATH: binDir, DISPLAY: ":1", AGENT_BROWSER_EXECUTABLE_PATH: chromium, ...overrides }
      });

      expect(probe()).toEqual({ available: true });

      // Non-executable browser file
      await chmod(chromium, 0o644);
      expect(probe()).toEqual({ available: false, reason: `missing browser executable ${chromium}` });
      await chmod(chromium, 0o755);

      // A DIRECTORY at the executable path must not count (accessSync X_OK
      // succeeds on directories — the probe requires a regular file).
      expect(probe({ AGENT_BROWSER_EXECUTABLE_PATH: binDir })).toEqual({
        available: false,
        reason: `missing browser executable ${binDir}`
      });

      // Empty PATH segments are skipped, not treated as cwd
      expect(getWebBrowserAvailability({
        env: { PATH: `${path.delimiter}${binDir}${path.delimiter}`, DISPLAY: ":1", AGENT_BROWSER_EXECUTABLE_PATH: chromium }
      })).toEqual({ available: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
