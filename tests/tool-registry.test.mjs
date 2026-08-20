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
      "spawn_agent", "agent_job"
    ]));
    expect(isMutationTool("read_file")).toBe(false);
    // shell_job is name-level read-only (status/logs/wait); the kill action
    // is gated as a mutation per-call inside the dispatch.
    expect(isMutationTool("shell_job")).toBe(false);
    // agent_job (issue #142) follows the same rule — and it MUST stay
    // read-only at the name level, or the scheduler would serialize waits on
    // several background children and undo the parallelism.
    expect(isMutationTool("agent_job")).toBe(false);
    expect(isMutationTool("spawn_agent")).toBe(true);
    expect(isMutationTool("write_file")).toBe(true);
    expect(isMutationTool("Edit")).toBe(true);
    expect(isMutationTool("run_shell")).toBe(true);
  });

  // Issue #142: the async spawn_agent mode and its JOIN tool must be exposed
  // exactly the way shell_job / run_shell's background mode are — same opt-in
  // flag shape, same deferred-loading path — or the model meets a tool it was
  // told about but whose schema never arrives.
  it("declares spawn_agent runInBackground and the agent_job schema alongside shell_job", () => {
    const defs = getToolDefinitions();
    const byName = Object.fromEntries(defs.map((tool) => [tool.function.name, tool.function]));

    expect(byName.spawn_agent.parameters.properties.runInBackground.type).toBe("boolean");
    expect(byName.spawn_agent.description).toContain("agent_job");

    expect(byName.agent_job.parameters.properties.action.enum).toEqual(["status", "wait", "kill", "list"]);
    // Only `action` is required — `list` takes no jobId.
    expect(byName.agent_job.parameters.required).toEqual(["action"]);
    expect(byName.agent_job.parameters.properties.jobId.type).toBe("string");
    expect(byName.agent_job.parameters.properties.waitMs.type).toBe("number");

    // Deferred tier, exactly like shell_job: not in the default catalog, and
    // appended once the session loads it.
    const base = selectToolDefinitions(defs, { loadedTools: [], settings: {} }).map((t) => t.function.name);
    expect(base).not.toContain("agent_job");
    expect(base).not.toContain("shell_job");
    const loaded = selectToolDefinitions(defs, { loadedTools: ["agent_job"], settings: {} }).map((t) => t.function.name);
    expect(loaded).toContain("agent_job");
    // ...and the load_tools summary advertises it, so the model can ask for it.
    const loadTools = base.includes("load_tools")
      ? selectToolDefinitions(defs, { loadedTools: [], settings: {} }).find((t) => t.function.name === "load_tools")
      : null;
    expect(loadTools.function.description).toContain("agent_job");
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
    // ADR 0038 D1: the run ⇄ conversation attach is HOST-supplied (the dispatcher
    // passes the owning AgentSession id). It must NOT be a model-writable tool
    // argument — otherwise a model could attach its run to another conversation.
    for (const name of ["start_run", "resume_run", "reply_run"]) {
      expect(byName[name].parameters.properties, `${name} must not expose conversationId`)
        .not.toHaveProperty("conversationId");
    }

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

  // ADR 0038 D2 — the deterministic launch: the dashboard starts the run and the
  // AI merely ACCOMPANIES it. attach_run is start_run minus the POST.
  it("exposes attach_run (accompany an already-started run) taking only runId, classified read-only", () => {
    const byName = Object.fromEntries(getToolDefinitions().map((tool) => [tool.function.name, tool.function]));

    expect(byName.attach_run, "attach_run should be registered").toBeTruthy();
    expect(byName.attach_run.parameters.properties.runId.type).toBe("string");
    expect(byName.attach_run.parameters.required).toEqual(["runId"]);
    // project / ticket come from the JOB, not from the model — and the attach is
    // host-supplied, exactly like start_run's.
    for (const key of ["project", "ticket", "conversationId", "command"]) {
      expect(byName.attach_run.parameters.properties, `attach_run must not expose ${key}`)
        .not.toHaveProperty(key);
    }
    // It starts nothing, so it is NOT a mutation: gating it would ask the user to
    // approve watching a run they just launched themselves. The minutes-long
    // await is a scheduling concern (turn-orchestrator budget), not an approval one.
    expect(isMutationTool("attach_run")).toBe(false);

    // start_run stays registered — the AI-driven launch is still a first-class
    // path (ADR 0038 D3), attach_run does not replace it.
    expect(byName.start_run).toBeTruthy();
  });

  /**
   * Issue #143 Phase 2 — the JOIN no longer polls, so the ONLY thing feeding the
   * turn-idle watchdog (180s of session-event silence aborts the whole turn) is
   * the wait's heartbeat travelling supervisor → run-control → onProgress →
   * activity.tick. This pins the dispatcher half of that chain; the
   * onProgress → activity.tick half is pinned in tests/turn-orchestrator.
   */
  it("bridges the wake supervisor's awaitSettle into attach_run, heartbeats included", async () => {
    const prevToken = process.env.PROCWAY_PROXY_TOKEN;
    process.env.PROCWAY_PROXY_TOKEN = "tkn";
    try {
      const seen = [];
      const ticks = [];
      const wakeSupervisor = {
        awaitSettle: async (jobId, opts) => {
          seen.push({ jobId, opts });
          // Three heartbeats, as a long JOIN would emit over a minute.
          for (let i = 1; i <= 3; i += 1) opts.onHeartbeat?.({ jobId, waitedMs: i * 20_000 });
          return {
            jobId, kind: "run", status: "awaiting-user-input", inputKind: "conversational",
            hearing: "Which DB?", project: "proj-a", ticket: "TK-1", runSessionId: "sess-1"
          };
        },
        collect: (target) => { seen.push({ collected: target }); return true; }
      };

      const result = await executeToolCall({
        name: "attach_run",
        args: { runId: "run_1" },
        cwd: process.cwd(),
        settings: { approvalMode: "auto-readonly", tools: { longRunningShellTimeoutMs: 1_800_000 } },
        approvalRequester: async () => true,
        wakeSupervisor,
        onProgress: (p) => ticks.push(p)
      });

      // The wait was handed the run id, a deadline BELOW the scheduler's budget
      // (longRunningShellTimeoutMs + 30s) and a sub-watchdog heartbeat cadence.
      expect(seen[0].jobId).toBe("run_1");
      expect(seen[0].opts.timeoutMs).toBeLessThan(1_800_000 + 30_000);
      expect(seen[0].opts.heartbeatMs).toBeLessThan(60_000);

      // Heartbeats reached the progress channel: 1 opening + 3 beats + 1 close.
      expect(ticks).toHaveLength(5);
      expect(ticks.every((t) => t.detail.includes("run_1"))).toBe(true);
      expect(ticks.at(-1).detail).toBe("run run_1: awaiting-user-input");

      // The yield still carries what resume_run / reply_run need.
      expect(isToolResult(result)).toBe(true);
      expect(result.data).toMatchObject({ project: "proj-a", ticket: "TK-1", sessionId: "sess-1", hearing: "Which DB?" });
      // ...and the supervisor was told not to ALSO wake about this run.
      expect(seen.at(-1).collected).toMatchObject({ jobId: "run_1", project: "proj-a", ticket: "TK-1" });
    } finally {
      if (prevToken === undefined) delete process.env.PROCWAY_PROXY_TOKEN;
      else process.env.PROCWAY_PROXY_TOKEN = prevToken;
    }
  });

  /**
   * Issue #143 follow-up — the dispatcher must hand attach_run the OWNING
   * conversation id, exactly as it does for start_run/resume_run/reply_run.
   * Without it the declaration is empty and the host never learns where to push
   * the run's settle, which is the whole regression: a run started by the
   * ticket header's「実行」button carries no conversation of its own.
   */
  it("declares the calling conversation when joining a run (attach_run → POST /attach)", async () => {
    const prevToken = process.env.PROCWAY_PROXY_TOKEN;
    const prevUrl = process.env.PROCWAY_DASHBOARD_URL;
    const prevFetch = globalThis.fetch;
    process.env.PROCWAY_PROXY_TOKEN = "tkn";
    process.env.PROCWAY_DASHBOARD_URL = "https://dash.example.test";
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const body = { jobId: "run_1", status: "running", project: "proj-a", ticket: "TK-1" };
      return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
    };
    try {
      const result = await executeToolCall({
        name: "attach_run",
        args: { runId: "run_1" },
        cwd: process.cwd(),
        settings: { approvalMode: "auto-readonly" },
        approvalRequester: async () => true,
        // The host's AgentSession id — NOT a model-supplied argument.
        sessionId: "conv-abc",
        wakeSupervisor: {
          awaitSettle: async () => ({ jobId: "run_1", kind: "run", status: "completed", project: "proj-a", ticket: "TK-1" }),
          collect: () => true
        }
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://dash.example.test/api/run/jobs/run_1/attach");
      expect(requests[0].init.method).toBe("POST");
      expect(JSON.parse(requests[0].init.body)).toEqual({ conversationId: "conv-abc" });
      expect(result.data).toMatchObject({ jobId: "run_1", status: "completed" });
    } finally {
      globalThis.fetch = prevFetch;
      if (prevToken === undefined) delete process.env.PROCWAY_PROXY_TOKEN;
      else process.env.PROCWAY_PROXY_TOKEN = prevToken;
      if (prevUrl === undefined) delete process.env.PROCWAY_DASHBOARD_URL;
      else process.env.PROCWAY_DASHBOARD_URL = prevUrl;
    }
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
