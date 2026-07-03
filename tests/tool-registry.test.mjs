import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectDisplayToolAvailability, executeToolCall, getToolDefinitions, isMutationTool, selectToolDefinitions } from "../src/tools/registry.mjs";
import { isToolResult } from "../src/core/types/tool-result.mjs";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";

describe("tool registry", () => {
  it("exposes read-only tools, run_shell, Edit, and the Phase 6 background-shell helpers", () => {
    const names = getToolDefinitions().map((tool) => tool.function.name);
    expect(names).toEqual(expect.arrayContaining([
      "list_files", "read_file", "search_files",
      "write_file", "apply_patch", "Edit",
      "run_shell", "shell_job",
      "spawn_agent"
    ]));
    expect(isMutationTool("read_file")).toBe(false);
    // shell_job is name-level read-only (status/logs/wait); the kill action
    // is gated as a mutation per-call inside the dispatch.
    expect(isMutationTool("shell_job")).toBe(false);
    expect(isMutationTool("write_file")).toBe(true);
    expect(isMutationTool("Edit")).toBe(true);
    expect(isMutationTool("run_shell")).toBe(true);
  });

  it("exposes the typed run-control tools (start_run/get_run_status/resume_run) with structured schemas, not a free-form command string", () => {
    const defs = getToolDefinitions();
    const byName = Object.fromEntries(defs.map((tool) => [tool.function.name, tool.function]));

    for (const name of ["start_run", "get_run_status", "resume_run"]) {
      expect(byName[name], `${name} should be registered`).toBeTruthy();
      // None of the typed run tools accept a free-form shell `command`.
      expect(byName[name].parameters.properties).not.toHaveProperty("command");
    }
    // There is deliberately NO answer_run tool: a hearing is resolved by the
    // real user via the widget (authenticity gate), then the AI calls resume_run.
    expect(byName.answer_run, "answer_run must NOT be registered").toBeUndefined();

    expect(byName.start_run.parameters.properties.project.type).toBe("string");
    expect(byName.start_run.parameters.properties.ticket.type).toBe("string");
    expect(byName.start_run.parameters.properties.autoApprove.type).toBe("boolean");
    expect(byName.start_run.parameters.required).toEqual(["project", "ticket"]);

    expect(byName.get_run_status.parameters.properties.jobId.type).toBe("string");
    expect(byName.get_run_status.parameters.required).toEqual(["jobId"]);

    expect(byName.resume_run.parameters.properties.project.type).toBe("string");
    expect(byName.resume_run.parameters.properties.ticket.type).toBe("string");
    expect(byName.resume_run.parameters.required).toEqual(["project", "ticket"]);

    // start_run / resume_run mutate; get_run_status is a read-only poll.
    expect(isMutationTool("start_run")).toBe(true);
    expect(isMutationTool("resume_run")).toBe(true);
    expect(isMutationTool("get_run_status")).toBe(false);

    // run_shell is untouched (still present).
    expect(byName.run_shell).toBeTruthy();
  });

  it("runs safe shell commands without approval and returns a ToolResult", async () => {
    const approvalRequester = vi.fn(async () => true);
    const shellRunner = vi.fn(async () => ({
      kind: "run_shell",
      summary: "Ran: git status --short (exit 0)",
      data: { command: "git status --short", exitCode: 0, stdout: "ok\n", stderr: "" }
    }));

    const result = await executeToolCall({
      name: "run_shell",
      args: { command: "git status --short" },
      cwd: process.cwd(),
      settings: { approvalMode: "auto-readonly", tools: {} },
      approvalRequester,
      shellRunner
    });

    expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({
      kind: "run_shell",
      mutation: false
    }));
    expect(shellRunner).toHaveBeenCalledOnce();
    expect(isToolResult(result)).toBe(true);
    expect(result.data.stdout).toBe("ok\n");
  });

  it("skips dangerous shell commands when approval is denied", async () => {
    const approvalRequester = vi.fn(async () => false);
    const shellRunner = vi.fn();

    const result = await executeToolCall({
      name: "run_shell",
      args: { command: "git reset --hard HEAD" },
      cwd: process.cwd(),
      settings: { approvalMode: "always-ask", tools: {} },
      approvalRequester,
      shellRunner
    });

    expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({
      kind: "run_shell",
      mutation: true
    }));
    expect(shellRunner).not.toHaveBeenCalled();
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("run_shell");
    expect(result.data.skipped).toBe(true);
    expect(result.data.classification.reasons).toContain("destructive");
  });

  it("skips write_file when approval is denied", async () => {
    const approvalRequester = vi.fn(async () => false);

    const result = await executeToolCall({
      name: "write_file",
      args: { filePath: "x.txt", content: "hello" },
      cwd: process.cwd(),
      settings: { approvalMode: "always-ask" },
      approvalRequester
    });

    expect(approvalRequester).toHaveBeenCalledWith(expect.objectContaining({
      kind: "write_file",
      mutation: true,
      summary: "x.txt"
    }));
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("write_file");
    expect(result.data.skipped).toBe(true);
    expect(result.data.path).toBe("x.txt");
  });

  it("allows write_file in full-auto mode", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
    const approvalRequester = vi.fn(async ({ approvalMode }) => approvalMode === "full-auto");

    try {
      const result = await executeToolCall({
        name: "write_file",
        args: { filePath: "full-auto-test.txt", content: "hello" },
        cwd,
        settings: { approvalMode: "full-auto" },
        approvalRequester
      });

      expect(isToolResult(result)).toBe(true);
      expect(result.kind).toBe("write_file");
      expect(result.data.path).toContain("full-auto-test.txt");
      expect(result.data.bytes).toBe(5);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs spawn_agent through the provided child runner and wraps the response", async () => {
    const childAgentRunner = vi.fn(async () => ({ text: "child result\n", exitCode: 0 }));

    const result = await executeToolCall({
      name: "spawn_agent",
      args: { task: "inspect", cwd: "." },
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      approvalRequester: vi.fn(async () => true),
      childAgentRunner
    });

    // ADR 0029 P3: spawn_agent now rides the `agent` kind delegated job, so the
    // child runner is invoked through the driver with extra onEvent/signal
    // plumbing — assert the load-bearing args survive the round-trip.
    expect(childAgentRunner).toHaveBeenCalledWith(
      expect.objectContaining({ task: "inspect", childCwd: "." })
    );
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("spawn_agent");
    expect(result.data.text).toBe("child result\n");
  });

  // ADR 0029 P3 round-trip: spawn_agent dispatch → an `agent` kind delegated job
  // in the registry → awaitJobYield → the SAME tool-result shape. Inject a fresh
  // registry so the job is observable and isolated from the shared one.
  it("routes spawn_agent through an agent kind delegated job and preserves the result shape", async () => {
    const jobRegistry = new DelegatedJobRegistry();
    const spawned = [];
    const origSpawn = jobRegistry.spawnJob.bind(jobRegistry);
    jobRegistry.spawnJob = (opts) => { spawned.push(opts); return origSpawn(opts); };

    const childAgentRunner = vi.fn(async () => ({
      text: "ok\n", exitCode: 0, sessionId: "sess-1", depth: 1, cwd: "/ws"
    }));

    const result = await executeToolCall({
      name: "spawn_agent",
      args: { task: "scan", cwd: "sub" },
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      approvalRequester: vi.fn(async () => true),
      childAgentRunner,
      jobRegistry
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].kind).toBe("agent");
    expect(spawned[0].spec).toEqual({ task: "scan", childCwd: "sub" });
    expect(childAgentRunner).toHaveBeenCalledWith(
      expect.objectContaining({ task: "scan", childCwd: "sub" })
    );
    expect(result.kind).toBe("spawn_agent");
    expect(result.data).toMatchObject({ text: "ok\n", exitCode: 0, sessionId: "sess-1", depth: 1, cwd: "/ws" });
  });

  it("propagates a failed child agent job as a throw (preserves prior contract)", async () => {
    const jobRegistry = new DelegatedJobRegistry();
    const childAgentRunner = vi.fn(async () => { throw new Error("child kaboom"); });

    await expect(executeToolCall({
      name: "spawn_agent",
      args: { task: "scan" },
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      approvalRequester: vi.fn(async () => true),
      childAgentRunner,
      jobRegistry
    })).rejects.toThrow(/child kaboom/);
  });

  // UIR non-interactive skip (issue #118): a session with no interaction surface
  // (`-p` run-loop worker, TUI) leaves interactionRequester unwired, so
  // request_user_action returns a skipped result at once instead of blocking the
  // turn on a UIR nobody can answer. The task SKILLs tell the worker to fall back
  // to prose elicitation when it sees `skipped`.
  it("skips request_user_action when no interaction surface is wired", async () => {
    const result = await executeToolCall({
      name: "request_user_action",
      args: { kind: "survey", summary: "pick one", spec: { questions: [] } },
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      // interactionRequester intentionally omitted (non-interactive)
    });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("interaction");
    expect(result.data.skipped).toBe(true);
    expect(result.data.reason).toBe("no-interaction-requester");
  });

  it("routes request_user_action through the interaction requester when wired", async () => {
    const interactionRequester = vi.fn(async () => ({ answers: [{ questionId: "q1", selected: "a" }] }));
    const result = await executeToolCall({
      name: "request_user_action",
      args: { kind: "survey", summary: "pick one", spec: { questions: [{ id: "q1" }] } },
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      interactionRequester
    });
    expect(interactionRequester).toHaveBeenCalledWith(expect.objectContaining({ kind: "survey", blocking: true }));
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("interaction");
    expect(result.data.skipped).toBeUndefined();
    expect(result.data.response).toEqual({ answers: [{ questionId: "q1", selected: "a" }] });
  });

  // §6 run-loop hearing RETURN mode: the requester records the request and
  // returns `{ deferred: true }` (non-blocking). The registry must NOT echo the
  // raw response; it must instruct the model to END the turn and not self-answer
  // / not call task complete.
  it("returns an end-turn directive when request_user_action is deferred (return mode)", async () => {
    const interactionRequester = vi.fn(async () => ({ requestId: "req-9", blocking: false, deferred: true }));
    const result = await executeToolCall({
      name: "request_user_action",
      args: { kind: "survey", summary: "pick one", spec: { questions: [{ id: "q1" }] } },
      cwd: process.cwd(),
      settings: { approvalMode: "full-auto" },
      interactionRequester
    });
    expect(isToolResult(result)).toBe(true);
    expect(result.kind).toBe("interaction");
    expect(result.data.deferred).toBe(true);
    expect(result.data.requestId).toBe("req-9");
    expect(result.data.blocking).toBe(false);
    expect(result.data.response).toBeUndefined();
    expect(String(result.data.note)).toMatch(/end your turn/i);
  });
});

describe("display-tool availability gating (ADR 0030 D5)", () => {
  const AVAILABLE = { available: true };
  const ALL_AVAILABLE = { web_browser: AVAILABLE, desktop_action: AVAILABLE };

  it("registers web_browser and desktop_action when the environment supports them", () => {
    const names = getToolDefinitions({ availability: ALL_AVAILABLE }).map((tool) => tool.function.name);
    expect(names).toContain("web_browser");
    expect(names).toContain("desktop_action");
  });

  it("drops an unavailable tool from the catalog AND the load_tools summary", () => {
    const availability = {
      web_browser: { available: false, reason: "missing binary agent-browser" },
      desktop_action: AVAILABLE
    };
    const defs = getToolDefinitions({ availability });
    const names = defs.map((tool) => tool.function.name);
    expect(names).not.toContain("web_browser");
    expect(names).toContain("desktop_action");

    const loadTools = selectToolDefinitions(defs, { availability })
      .find((tool) => tool.function.name === "load_tools");
    expect(loadTools.function.description).not.toContain("web_browser");
    expect(loadTools.function.description).toContain("desktop_action");
  });

  it("drops both tools where neither binary set nor DISPLAY is usable", () => {
    const availability = {
      web_browser: { available: false, reason: "DISPLAY unset" },
      desktop_action: { available: false, reason: "missing binary xdotool, DISPLAY unset" }
    };
    const names = getToolDefinitions({ availability }).map((tool) => tool.function.name);
    expect(names).not.toContain("web_browser");
    expect(names).not.toContain("desktop_action");
    // The rest of the catalog is untouched.
    expect(names).toContain("run_shell");
  });

  it("logs a single line naming each disabled tool and why", () => {
    const logger = vi.fn();
    const availability = detectDisplayToolAvailability({
      desktopAvailability: () => ({ available: false, reason: "missing binary xdotool, DISPLAY unset" }),
      webBrowserAvailability: () => ({ available: false, reason: "missing binary agent-browser" }),
      logger
    });
    expect(availability.desktop_action.available).toBe(false);
    expect(availability.web_browser.available).toBe(false);
    expect(logger).toHaveBeenCalledTimes(1);
    const line = logger.mock.calls[0][0];
    expect(line).toContain("desktop_action — missing binary xdotool, DISPLAY unset");
    expect(line).toContain("web_browser — missing binary agent-browser");
    // Self-hosters need to know how to recover without spelunking the source.
    expect(line).toContain("hot-reload");
  });

  it("forwards settings to the web_browser detector (settings.tools.browser overrides count)", () => {
    const webBrowserAvailability = vi.fn(() => AVAILABLE);
    const settings = { tools: { browser: { headed: false } } };
    detectDisplayToolAvailability({
      settings,
      desktopAvailability: () => AVAILABLE,
      webBrowserAvailability,
      logger: vi.fn()
    });
    expect(webBrowserAvailability).toHaveBeenCalledWith({ settings });
  });

  it("stays silent when everything is available", () => {
    const logger = vi.fn();
    const availability = detectDisplayToolAvailability({
      desktopAvailability: () => AVAILABLE,
      webBrowserAvailability: () => AVAILABLE,
      logger
    });
    expect(availability).toEqual(ALL_AVAILABLE);
    expect(logger).not.toHaveBeenCalled();
  });
});
