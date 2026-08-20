import { describe, expect, it } from "vitest";
import { startRun, attachRun, getRunStatus, resumeRun, replyRun, joinTimeoutMsFor } from "../src/tools/run-control.mjs";
import { createWakeSupervisor } from "../src/agent/wake-supervisor.mjs";
import { DelegatedJobRegistry } from "../src/jobs/delegated-jobs.mjs";

const DASH = "https://dash.example.test";
const TOKEN = "proxy-token-123";

/**
 * Build a plain async fetch stub (no vi.fn mocking of internals): it records
 * every call and returns a canned JSON response. Mirrors the openai-codex
 * provider tests, which inject a hand-rolled async fetch.
 */
function makeFetch({ ok = true, status = 200, statusText = "OK", json = {}, text } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      statusText,
      json: async () => json,
      text: async () => (text !== undefined ? text : JSON.stringify(json))
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/**
 * A fetch that answers the POST (start / resume / reply) with `post` and any
 * GET with `get`. Since issue #143 Phase 2 there is NO poll loop, so a GET here
 * can only ever be the ONE confirming read the JOIN falls back to — which is
 * exactly what several tests below assert by counting calls.
 */
function makeSeqFetch({ post = { jobId: "job_1", status: "running" }, get = null, ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const method = init.method ?? "GET";
    const json = method === "GET" ? (get ?? {}) : post;
    return {
      ok,
      status: 200,
      statusText: "OK",
      json: async () => json,
      text: async () => JSON.stringify(json)
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/**
 * The `awaitSettle` seam the dispatcher injects (tools/registry.mjs bridges it
 * to the session's wake supervisor). Resolves with `item`, or with null to
 * simulate "the wait ran out" — the only two outcomes run-control handles.
 *
 * `beats` fires that many heartbeats first: the watchdog-feeding contract.
 */
function makeAwaitSettle({ item = null, beats = 0 } = {}) {
  const calls = [];
  const awaitSettle = async (jobId, opts = {}) => {
    calls.push({ jobId, opts });
    for (let i = 1; i <= beats; i += 1) {
      opts.onHeartbeat?.({ jobId, waitedMs: i * 20_000 });
    }
    return item;
  };
  awaitSettle.calls = calls;
  return awaitSettle;
}

/** A settled run, in the wake-item shape the supervisor hands out. */
function settle(extra = {}) {
  return { jobId: "job_1", kind: "run", status: "completed", project: "", ticket: "", ...extra };
}

describe("run-control tool facade", () => {
  describe("startRun (await-yield over the settle EVENT — issue #143 Phase 2)", () => {
    it("POSTs to /api/run/jobs, waits for the settle, and returns the yield WITHOUT any polling", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_1", status: "running" } });
      const awaitSettle = makeAwaitSettle({
        item: settle({
          status: "awaiting-user-input",
          inputKind: "conversational",
          hearing: "Which DB?",
          runSessionId: "sess-1",
          pendingTask: "plan-todo",
          result: { status: "awaiting-user-input", runCount: 0, sessionId: "sess-1", pendingTask: "plan-todo" }
        })
      });
      const result = await startRun({
        project: "proj-a",
        ticket: "T-9",
        autoApprove: true,
        dashboardUrl: DASH,
        proxyToken: TOKEN,
        fetchImpl,
        awaitSettle
      });

      // THE point of Phase 2: one POST, zero GETs. A single GET here would mean
      // the poll came back.
      expect(fetchImpl.calls).toHaveLength(1);
      const post = fetchImpl.calls[0];
      expect(post.url).toBe(`${DASH}/api/run/jobs`);
      expect(post.init.method).toBe("POST");
      expect(post.init.headers["x-procway-session"]).toBe(TOKEN);
      expect(post.init.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(post.init.body)).toEqual({ project: "proj-a", ticket: "T-9", autoApprove: true });

      expect(awaitSettle.calls[0].jobId).toBe("job_1");
      expect(result).toEqual({
        kind: "start_run",
        jobId: "job_1",
        status: "awaiting-user-input",
        inputKind: "conversational",
        hearing: "Which DB?",
        sessionId: "sess-1",
        pendingTask: "plan-todo",
        result: { status: "awaiting-user-input", runCount: 0, sessionId: "sess-1", pendingTask: "plan-todo" },
        project: "proj-a",
        ticket: "T-9"
      });
    });

    it("surfaces a structured interaction yield (inputKind structured)", async () => {
      const fetchImpl = makeSeqFetch();
      const awaitSettle = makeAwaitSettle({
        item: settle({ status: "awaiting-user-input", inputKind: "structured", interaction: { requestId: "r1", kind: "approval" } })
      });
      const result = await startRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle });
      expect(result.inputKind).toBe("structured");
      expect(result.interaction).toEqual({ requestId: "r1", kind: "approval" });
      expect(result.hearing).toBeUndefined();
    });

    it("omits autoApprove when not a boolean and trims a trailing slash on the base URL", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_2", status: "running" } });
      await startRun({ project: "p", ticket: "t", dashboardUrl: `${DASH}/`, proxyToken: TOKEN, fetchImpl, awaitSettle: makeAwaitSettle({ item: settle({ jobId: "job_2" }) }) });
      const post = fetchImpl.calls[0];
      expect(post.url).toBe(`${DASH}/api/run/jobs`);
      expect(JSON.parse(post.init.body)).toEqual({ project: "p", ticket: "t" });
    });

    it("throws when project or ticket is missing (before any fetch)", async () => {
      const fetchImpl = makeFetch();
      await expect(startRun({ ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/project is required/);
      await expect(startRun({ project: "p", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/ticket is required/);
      expect(fetchImpl.calls).toHaveLength(0);
    });

    it("throws with status + body message on a non-OK POST (before waiting)", async () => {
      const fetchImpl = makeFetch({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: JSON.stringify({ statusMessage: "ジョブ開始中に予期しないエラー" })
      });
      const awaitSettle = makeAwaitSettle({ item: settle() });
      await expect(startRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle }))
        .rejects.toThrow(/start_run failed: 500.*ジョブ開始中に予期しないエラー/);
      expect(fetchImpl.calls).toHaveLength(1); // POST only
      expect(awaitSettle.calls).toHaveLength(0);
    });

    it("throws when the dashboard URL or proxy token is missing", async () => {
      const fetchImpl = makeFetch();
      await expect(startRun({ project: "p", ticket: "t", dashboardUrl: "", proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/PROCWAY_DASHBOARD_URL is not set/);
      await expect(startRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: "", fetchImpl }))
        .rejects.toThrow(/PROCWAY_PROXY_TOKEN is not set/);
    });
  });

  // Issue #143 Phase 2 — the turn-idle watchdog (conversation.mjs, 180s of event
  // silence aborts the TURN) used to be fed implicitly by the 2s poll. With the
  // poll gone the ONLY heartbeat is awaitSettle's onHeartbeat, forwarded to
  // onProgress → activity.tick. A JOIN that stops ticking dies at 180s, so this
  // wiring is pinned here and at the dispatcher (tests/tool-registry).
  describe("turn-idle heartbeat while the JOIN blocks", () => {
    it("ticks once up front and once per heartbeat, with the run id and status in the detail", async () => {
      const ticks = [];
      const awaitSettle = makeAwaitSettle({ beats: 3, item: settle({ status: "completed" }) });
      await startRun({
        project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN,
        fetchImpl: makeSeqFetch(), awaitSettle, onProgress: (p) => ticks.push(p)
      });
      // 1 opening tick + 3 heartbeats + 1 closing tick.
      expect(ticks).toHaveLength(5);
      expect(ticks[0].detail).toMatch(/^run job_1: running/);
      expect(ticks[1].detail).toMatch(/run job_1: running .*\(20s\)/);
      expect(ticks[3].detail).toMatch(/\(60s\)/);
      expect(ticks[4].detail).toBe("run job_1: completed");
    });

    it("asks for a heartbeat cadence far below the 180s turn-idle watchdog", async () => {
      const awaitSettle = makeAwaitSettle({ item: settle() });
      await attachRun({ runId: "job_1", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: makeSeqFetch(), awaitSettle });
      const { heartbeatMs, timeoutMs } = awaitSettle.calls[0].opts;
      expect(heartbeatMs).toBeGreaterThan(0);
      expect(heartbeatMs).toBeLessThan(60_000);
      expect(timeoutMs).toBe(joinTimeoutMsFor(undefined));
    });

    it("survives an onProgress that throws (a heartbeat must never break the JOIN)", async () => {
      const awaitSettle = makeAwaitSettle({ beats: 2, item: settle() });
      const result = await attachRun({
        runId: "job_1", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: makeSeqFetch(),
        awaitSettle, onProgress: () => { throw new Error("surface gone"); }
      });
      expect(result.status).toBe("completed");
    });
  });

  // The JOIN's own deadline must stay BELOW the scheduler's tool budget
  // (turn-orchestrator toolCallBudgetMs = longRunningShellTimeoutMs + 30s) so the
  // tool answers for itself instead of being SIGTERMed with nothing to say.
  describe("joinTimeoutMsFor (deadline vs. the scheduler budget)", () => {
    it("sits one margin below the long-running ceiling the budget is built from", () => {
      const lr = 30 * 60_000;
      const budget = lr + 30_000; // what toolCallBudgetMs grants
      expect(joinTimeoutMsFor(lr)).toBeLessThan(budget);
      expect(joinTimeoutMsFor(lr)).toBe(lr - 60_000);
    });

    it("never collapses to zero for a tiny or absent configuration", () => {
      expect(joinTimeoutMsFor(1000)).toBe(60_000);
      expect(joinTimeoutMsFor(undefined)).toBeGreaterThanOrEqual(60_000);
      expect(joinTimeoutMsFor("nonsense")).toBe(joinTimeoutMsFor(undefined));
    });
  });

  // Issue #141 — the background half of start_run. The whole point is what it
  // does NOT do: after the POST it neither reads nor waits, so several
  // background starts in a row never serialize.
  describe("startRun (runInBackground — issue #141)", () => {
    it("POSTs once and returns the jobId without waiting for anything", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_bg", status: "running" } });
      const awaitSettle = makeAwaitSettle({ item: settle({ jobId: "job_bg" }) });
      const result = await startRun({
        project: "proj-a",
        ticket: "T-1",
        runInBackground: true,
        dashboardUrl: DASH,
        proxyToken: TOKEN,
        fetchImpl,
        awaitSettle
      });

      expect(fetchImpl.calls).toHaveLength(1);
      expect(fetchImpl.calls[0].init.method).toBe("POST");
      // Waiting here would be the bug: the settle is delivered as a WAKE.
      expect(awaitSettle.calls).toHaveLength(0);
      expect(result).toEqual({
        kind: "start_run",
        jobId: "job_bg",
        status: "running",
        background: true,
        project: "proj-a",
        ticket: "T-1"
      });
    });

    it("still attaches the run to the launching conversation (ADR 0038 D1)", async () => {
      // A background run's settle must still reach where it was started from —
      // that attach is exactly what makes the wake (and the JOIN) possible.
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_bg", status: "running" } });
      await startRun({
        project: "p",
        ticket: "t",
        conversationId: "conv-x",
        runInBackground: true,
        dashboardUrl: DASH,
        proxyToken: TOKEN,
        fetchImpl
      });
      expect(JSON.parse(fetchImpl.calls[0].init.body)).toEqual({ project: "p", ticket: "t", conversationId: "conv-x" });
    });

    it("keeps the awaiting behaviour when runInBackground is false / omitted", async () => {
      for (const runInBackground of [undefined, false]) {
        const fetchImpl = makeSeqFetch({ post: { jobId: "job_1", status: "running" } });
        const awaitSettle = makeAwaitSettle({ item: settle({ status: "completed" }) });
        const result = await startRun({
          project: "p", ticket: "t", runInBackground,
          dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle
        });
        expect(awaitSettle.calls).toHaveLength(1);
        expect(result.status).toBe("completed");
        expect(result.background).toBeUndefined();
      }
    });

    it("starts several runs back to back, each returning immediately", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_bg", status: "running" } });
      const results = await Promise.all([
        startRun({ project: "p", ticket: "T-1", runInBackground: true, dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }),
        startRun({ project: "p", ticket: "T-2", runInBackground: true, dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }),
        startRun({ project: "p", ticket: "T-3", runInBackground: true, dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl })
      ]);
      // Exactly one call per run: three POSTs, nothing else.
      expect(fetchImpl.calls).toHaveLength(3);
      expect(fetchImpl.calls.every((c) => c.init.method === "POST")).toBe(true);
      expect(results.map((r) => r.ticket)).toEqual(["T-1", "T-2", "T-3"]);
      expect(results.every((r) => r.background === true && r.status === "running")).toBe(true);
    });
  });

  // ADR 0038 D2 — the ticket header's「実行」button starts the run and hands the
  // AI a run id; issue #141 gave attach_run a second job as the JOIN for a run
  // this session started in the background. Either way it is start_run MINUS the
  // POST: the same rendezvous, no side effect, and it learns project/ticket from
  // the run itself (they are deliberately not model-writable arguments).
  describe("attachRun (accompany an already-started run)", () => {
    it("never POSTs and never reads — it waits for the settle and returns the yield", async () => {
      const fetchImpl = makeSeqFetch();
      const awaitSettle = makeAwaitSettle({
        item: settle({
          jobId: "job_9",
          status: "awaiting-user-input",
          inputKind: "conversational",
          hearing: "Which environment?",
          project: "proj-a",
          ticket: "T-1",
          runSessionId: "sess-9"
        })
      });
      const result = await attachRun({ runId: "job_9", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle });

      expect(fetchImpl.calls).toHaveLength(0);
      expect(result).toEqual({
        kind: "attach_run",
        jobId: "job_9",
        status: "awaiting-user-input",
        inputKind: "conversational",
        hearing: "Which environment?",
        sessionId: "sess-9",
        // Resolved from the RUN — reply_run / resume_run need them and the model
        // was never asked for them (attach_run's schema carries only runId).
        project: "proj-a",
        ticket: "T-1"
      });
    });

    it("carries project/ticket into the yield for every awaiting tool, so a pause stays resumable", async () => {
      const cases = [
        ["attach_run", () => attachRun({ runId: "job_1", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: makeSeqFetch(), awaitSettle: makeAwaitSettle({ item: settle({ project: "proj-a", ticket: "T-1" }) }) })],
        ["start_run", () => startRun({ project: "proj-a", ticket: "T-1", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: makeSeqFetch(), awaitSettle: makeAwaitSettle({ item: settle() }) })],
        ["resume_run", () => resumeRun({ project: "proj-a", ticket: "T-1", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: makeSeqFetch(), awaitSettle: makeAwaitSettle({ item: settle() }) })],
        ["reply_run", () => replyRun({ project: "proj-a", ticket: "T-1", sessionId: "s", answer: "a", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: makeSeqFetch(), awaitSettle: makeAwaitSettle({ item: settle() }) })]
      ];
      for (const [kind, run] of cases) {
        const result = await run();
        expect(result.kind, kind).toBe(kind);
        expect(result.project, kind).toBe("proj-a");
        expect(result.ticket, kind).toBe("T-1");
      }
    });

    it("requires a runId and a proxy token, and issues no request without them", async () => {
      const fetchImpl = makeFetch();
      await expect(attachRun({ dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/runId is required/);
      await expect(attachRun({ runId: "  ", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/runId is required/);
      await expect(attachRun({ runId: "job_9", dashboardUrl: DASH, proxyToken: "", fetchImpl }))
        .rejects.toThrow(/PROCWAY_PROXY_TOKEN is not set/);
      expect(fetchImpl.calls).toHaveLength(0);
    });
  });

  /**
   * Issue #143 follow-up — the ATTACH DECLARATION.
   *
   * The host pushes a run's settle only to the conversation recorded ON the
   * run, and the ticket header's「実行」button starts its run with none (ADR 0038
   * D2). Before this, JOINing such a run waited to the full 6h-ish deadline and
   * then fell back to a confirming read — a regression the whole suite stayed
   * green through, because nothing tested WHO the settle was pushed to.
   * `attach_run` is the declaration, so it must send it.
   */
  describe("attachRun declares the attach before waiting (issue #143 follow-up)", () => {
    /** A fetch that answers POST /attach with `attach` and GET with `get`. */
    function makeAttachFetch({ attach = { jobId: "job_9", status: "running" }, get = null, attachOk = true, attachStatus = 200 } = {}) {
      const calls = [];
      const fetchImpl = async (url, init = {}) => {
        calls.push({ url, init });
        const isAttach = String(url).endsWith("/attach");
        if (isAttach) {
          return {
            ok: attachOk,
            status: attachStatus,
            statusText: attachOk ? "OK" : "Not Found",
            json: async () => attach,
            text: async () => JSON.stringify(attach)
          };
        }
        return { ok: true, status: 200, statusText: "OK", json: async () => (get ?? {}), text: async () => JSON.stringify(get ?? {}) };
      };
      fetchImpl.calls = calls;
      return fetchImpl;
    }

    it("POSTs the conversation id to /api/run/jobs/<id>/attach, then waits for the settle", async () => {
      const fetchImpl = makeAttachFetch();
      const awaitSettle = makeAwaitSettle({ item: settle({ jobId: "job_9", project: "proj-a", ticket: "T-1" }) });
      const result = await attachRun({
        runId: "job_9", conversationId: "conv-42",
        dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle
      });

      // Exactly ONE request: the declaration. No poll, no confirming read.
      expect(fetchImpl.calls).toHaveLength(1);
      const post = fetchImpl.calls[0];
      expect(post.url).toBe(`${DASH}/api/run/jobs/job_9/attach`);
      expect(post.init.method).toBe("POST");
      expect(post.init.headers["x-procway-session"]).toBe(TOKEN);
      expect(JSON.parse(post.init.body)).toEqual({ conversationId: "conv-42" });
      // …and it still WAITS: the declaration is what makes the wait resolvable.
      expect(awaitSettle.calls).toHaveLength(1);
      expect(result).toMatchObject({ kind: "attach_run", jobId: "job_9", status: "completed", project: "proj-a", ticket: "T-1" });
      expect(result.note).toBeUndefined();
    });

    it("sends nothing when the host gave it no conversation to declare", async () => {
      const fetchImpl = makeAttachFetch();
      await attachRun({
        runId: "job_9", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl,
        awaitSettle: makeAwaitSettle({ item: settle({ jobId: "job_9" }) })
      });
      // An empty attach is not a thing to declare.
      expect(fetchImpl.calls).toHaveLength(0);
    });

    it("returns the yield IMMEDIATELY when the declaration says the run already settled", async () => {
      const fetchImpl = makeAttachFetch({
        attach: {
          attached: true,
          jobId: "job_9",
          status: "awaiting-user-input",
          inputKind: "conversational",
          hearing: "Which environment?",
          project: "proj-a",
          ticket: "T-1",
          result: { status: "awaiting-user-input", sessionId: "sess-9", pendingTask: "plan-todo" }
        }
      });
      const awaitSettle = makeAwaitSettle({ item: settle() });
      const result = await attachRun({
        runId: "job_9", conversationId: "conv-42",
        dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle
      });

      // The settle already happened — there is none left to be pushed, so
      // waiting would burn the whole JOIN deadline for nothing.
      expect(awaitSettle.calls).toHaveLength(0);
      expect(fetchImpl.calls).toHaveLength(1);
      expect(result).toEqual({
        kind: "attach_run",
        jobId: "job_9",
        status: "awaiting-user-input",
        inputKind: "conversational",
        hearing: "Which environment?",
        sessionId: "sess-9",
        pendingTask: "plan-todo",
        result: { status: "awaiting-user-input", sessionId: "sess-9", pendingTask: "plan-todo" },
        project: "proj-a",
        ticket: "T-1"
      });
    });

    it("falls back to the pre-#143 path when the host has no /attach endpoint (404)", async () => {
      const fetchImpl = makeAttachFetch({
        attachOk: false,
        attachStatus: 404,
        attach: { data: { error: { message: "Cannot POST /api/run/jobs/job_9/attach" } } },
        get: { jobId: "job_9", status: "running", project: "p", ticket: "t" }
      });
      const awaitSettle = makeAwaitSettle({ item: null });
      const result = await attachRun({
        runId: "job_9", conversationId: "conv-42",
        dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle
      });

      // Declaration attempted, then EXACTLY the old behaviour: wait, then ONE
      // confirming read. Never an exception — procway-code ships standalone and
      // a host is allowed not to implement this.
      expect(fetchImpl.calls.map((c) => c.init.method ?? "GET")).toEqual(["POST", "GET"]);
      expect(awaitSettle.calls).toHaveLength(1);
      expect(result.status).toBe("running");
      expect(result.note).toMatch(/Could not declare this conversation as accompanying run job_9/);
      // The honest "still running" advice is not lost behind the declare note.
      expect(result.note).toMatch(/STILL RUNNING/);
    });

    it("does not fail the JOIN when the declaration throws (network / bad URL)", async () => {
      const calls = [];
      const fetchImpl = async (url, init = {}) => {
        calls.push({ url, init });
        if (String(url).endsWith("/attach")) throw new Error("ECONNREFUSED");
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ jobId: "job_9", status: "completed" }), text: async () => "{}" };
      };
      const result = await attachRun({
        runId: "job_9", conversationId: "conv-42",
        dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl,
        awaitSettle: makeAwaitSettle({ item: settle({ jobId: "job_9", project: "proj-a", ticket: "T-1" }) })
      });
      expect(result.status).toBe("completed");
      expect(result.project).toBe("proj-a");
      expect(result.note).toMatch(/ECONNREFUSED/);
    });

    it("keeps project/ticket on the yield in every declaration outcome", async () => {
      // From the declaration itself (terminal short-circuit)…
      const fromDeclare = await attachRun({
        runId: "job_9", conversationId: "conv-42", dashboardUrl: DASH, proxyToken: TOKEN,
        fetchImpl: makeAttachFetch({ attach: { jobId: "job_9", status: "completed", project: "proj-a", ticket: "T-1" } }),
        awaitSettle: makeAwaitSettle({ item: settle() })
      });
      expect(fromDeclare).toMatchObject({ project: "proj-a", ticket: "T-1" });

      // …and from the declaration while the settle item carries neither, which
      // is what keeps resume_run / reply_run callable after the JOIN.
      const fromWait = await attachRun({
        runId: "job_9", conversationId: "conv-42", dashboardUrl: DASH, proxyToken: TOKEN,
        fetchImpl: makeAttachFetch({ attach: { jobId: "job_9", status: "running", project: "proj-a", ticket: "T-1" } }),
        awaitSettle: makeAwaitSettle({ item: settle({ jobId: "job_9", project: "", ticket: "" }) })
      });
      expect(fromWait).toMatchObject({ project: "proj-a", ticket: "T-1" });
    });

    it("issues NO request when the turn was already interrupted", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchImpl = makeAttachFetch();
      const result = await attachRun({
        runId: "job_9", conversationId: "conv-42", dashboardUrl: DASH, proxyToken: TOKEN,
        fetchImpl, awaitSettle: makeAwaitSettle({ item: null }), signal: controller.signal
      });
      expect(fetchImpl.calls).toHaveLength(0);
      expect(result.note).toMatch(/Interrupted/);
    });

    it("declares before it waits — the order is the whole point", async () => {
      const order = [];
      const fetchImpl = async (url, init = {}) => {
        order.push(`fetch:${init.method ?? "GET"}`);
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ jobId: "job_9", status: "running" }), text: async () => "{}" };
      };
      const awaitSettle = async () => { order.push("await"); return settle({ jobId: "job_9" }); };
      await attachRun({ runId: "job_9", conversationId: "conv-42", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle });
      // Waiting first would re-open the exact race the declaration closes: a
      // settle that fires before the host knows where to push it.
      expect(order).toEqual(["fetch:POST", "await"]);
    });
  });

  /**
   * Issue #143 Phase 2 — the safe failure. A host may set
   * PROCWAY_DASHBOARD_URL and never implement the `wake` push; the wait then
   * ends with `null` and the JOIN answers with exactly ONE confirming read.
   * ONE — a loop here would be the poll coming back through the side door.
   */
  describe("the confirming read after the wait runs out", () => {
    it("reads once and returns the run's real yield when it had already settled", async () => {
      const fetchImpl = makeSeqFetch({
        get: {
          jobId: "job_9",
          status: "awaiting-user-input",
          inputKind: "conversational",
          hearing: "Which environment?",
          project: "proj-a",
          ticket: "T-1",
          result: { status: "awaiting-user-input", sessionId: "sess-9", pendingTask: "plan-todo" }
        }
      });
      const result = await attachRun({ runId: "job_9", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle: makeAwaitSettle({ item: null }) });

      expect(fetchImpl.calls).toHaveLength(1);
      expect(fetchImpl.calls[0].url).toBe(`${DASH}/api/run/jobs/job_9`);
      expect(fetchImpl.calls[0].init.method).toBeUndefined();
      expect(result).toEqual({
        kind: "attach_run",
        jobId: "job_9",
        status: "awaiting-user-input",
        inputKind: "conversational",
        hearing: "Which environment?",
        sessionId: "sess-9",
        pendingTask: "plan-todo",
        result: { status: "awaiting-user-input", sessionId: "sess-9", pendingTask: "plan-todo" },
        project: "proj-a",
        ticket: "T-1"
      });
      // No note: this IS the settled answer, not a "still running" fallback.
      expect(result.note).toBeUndefined();
    });

    it("says so honestly when the run is still going, and tells the model it will be woken", async () => {
      const fetchImpl = makeSeqFetch({ get: { jobId: "job_9", status: "running", project: "p", ticket: "t" } });
      const result = await attachRun({ runId: "job_9", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle: makeAwaitSettle({ item: null }) });
      expect(fetchImpl.calls).toHaveLength(1);
      expect(result.status).toBe("running");
      expect(result.project).toBe("p");
      expect(result.note).toMatch(/STILL RUNNING/);
      expect(result.note).toMatch(/woken automatically/);
      expect(result.note).toMatch(/NOT be restarted/);
    });

    it("does not throw when the confirming read itself fails", async () => {
      const fetchImpl = makeFetch({ ok: false, status: 404, statusText: "Not Found", text: JSON.stringify({ data: { error: { message: "run-loop job job_9 not found" } } }) });
      const result = await attachRun({ runId: "job_9", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle: makeAwaitSettle({ item: null }) });
      expect(fetchImpl.calls).toHaveLength(1);
      expect(result.status).toBe("unknown");
      expect(result.note).toMatch(/Could not read run job_9/);
      expect(result.note).toMatch(/Do not restart it/);
    });

    it("falls back to the same single read when no awaitSettle is injected at all (headless caller)", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_1", status: "running" }, get: { jobId: "job_1", status: "completed", result: { status: "completed" } } });
      const result = await startRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl });
      expect(fetchImpl.calls).toHaveLength(2); // the POST + ONE read
      expect(fetchImpl.calls[1].init.method).toBeUndefined();
      expect(result.status).toBe("completed");
    });

    it("returns without reading anything when the turn was interrupted", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchImpl = makeSeqFetch();
      const result = await attachRun({
        runId: "job_9", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl,
        awaitSettle: makeAwaitSettle({ item: null }), signal: controller.signal
      });
      expect(fetchImpl.calls).toHaveLength(0);
      expect(result.status).toBe("running");
      expect(result.note).toMatch(/Interrupted/);
    });
  });

  describe("getRunStatus", () => {
    it("GETs /api/run/jobs/:jobId with the session header and lifts result/interaction/error", async () => {
      const fetchImpl = makeFetch({
        json: { jobId: "job_3", status: "awaiting_input", interaction: { requestId: "r1" } }
      });
      const result = await getRunStatus({ jobId: "job_3", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl });

      const { url, init } = fetchImpl.calls[0];
      expect(url).toBe(`${DASH}/api/run/jobs/job_3`);
      expect(init.method).toBeUndefined();
      expect(init.headers["x-procway-session"]).toBe(TOKEN);
      expect(result).toEqual({
        kind: "get_run_status",
        jobId: "job_3",
        status: "awaiting_input",
        interaction: { requestId: "r1" }
      });
    });

    it("also lifts the pause fields the JOIN's confirming read depends on", async () => {
      // Without these a paused run read after the wait ran out would come back
      // with no hearing text and no project/ticket — i.e. unanswerable.
      const fetchImpl = makeFetch({
        json: { jobId: "job_3", status: "awaiting-user-input", inputKind: "conversational", hearing: "Which DB?", project: "p", ticket: "t" }
      });
      const result = await getRunStatus({ jobId: "job_3", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl });
      expect(result).toMatchObject({ inputKind: "conversational", hearing: "Which DB?", project: "p", ticket: "t" });
    });

    it("throws when jobId is missing and on a non-OK response", async () => {
      const fetchImpl = makeFetch();
      await expect(getRunStatus({ dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/jobId is required/);
      expect(fetchImpl.calls).toHaveLength(0);

      const notFound = makeFetch({ ok: false, status: 404, statusText: "Not Found", text: JSON.stringify({ data: { error: { message: "run-loop job job_x not found" } } }) });
      await expect(getRunStatus({ jobId: "job_x", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: notFound }))
        .rejects.toThrow(/get_run_status failed: 404.*not found/);
    });
  });

  describe("resumeRun (await-yield)", () => {
    it("POSTs to /api/run/jobs/resume, then waits for the settle and returns the yield", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_5", status: "running" } });
      const awaitSettle = makeAwaitSettle({ item: settle({ jobId: "job_5", status: "completed" }) });
      const result = await resumeRun({
        project: "proj-b",
        ticket: "T-2",
        dashboardUrl: DASH,
        proxyToken: TOKEN,
        fetchImpl,
        awaitSettle
      });

      const post = fetchImpl.calls[0];
      expect(post.url).toBe(`${DASH}/api/run/jobs/resume`);
      expect(post.init.method).toBe("POST");
      expect(post.init.headers["x-procway-session"]).toBe(TOKEN);
      expect(JSON.parse(post.init.body)).toEqual({ project: "proj-b", ticket: "T-2" });
      expect(fetchImpl.calls).toHaveLength(1);
      // The resume mints a NEW jobId — that is the one the wait is keyed on.
      expect(awaitSettle.calls[0].jobId).toBe("job_5");
      expect(result).toMatchObject({ kind: "resume_run", jobId: "job_5", status: "completed", project: "proj-b", ticket: "T-2" });
    });

    it("throws when project or ticket is missing", async () => {
      const fetchImpl = makeFetch();
      await expect(resumeRun({ ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/project is required/);
      await expect(resumeRun({ project: "p", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/ticket is required/);
      expect(fetchImpl.calls).toHaveLength(0);
    });

    it("throws with status + body on a non-OK response (e.g. no resolved hearing)", async () => {
      const fetchImpl = makeFetch({ ok: false, status: 409, statusText: "Conflict", text: JSON.stringify({ data: { error: { message: "チケット T-2 に解決済みのヒヤリングがありません" } } }) });
      await expect(resumeRun({ project: "p", ticket: "T-2", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/resume_run failed: 409.*解決済みのヒヤリングがありません/);
    });
  });

  describe("replyRun (conversational resume, await-yield)", () => {
    it("POSTs to /api/run/jobs/conversational-resume with sessionId+answer, then waits and returns the yield", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_7", status: "running" } });
      const awaitSettle = makeAwaitSettle({
        item: settle({ jobId: "job_7", status: "completed", runSessionId: "sess-9", result: { status: "completed", runCount: 2 } })
      });
      const result = await replyRun({
        project: "proj-c",
        ticket: "T-3",
        sessionId: "sess-9",
        answer: "Use Postgres.",
        dashboardUrl: DASH,
        proxyToken: TOKEN,
        fetchImpl,
        awaitSettle
      });

      const post = fetchImpl.calls[0];
      expect(post.url).toBe(`${DASH}/api/run/jobs/conversational-resume`);
      expect(post.init.method).toBe("POST");
      expect(post.init.headers["x-procway-session"]).toBe(TOKEN);
      expect(post.init.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(post.init.body)).toEqual({ project: "proj-c", ticket: "T-3", sessionId: "sess-9", answer: "Use Postgres." });

      expect(fetchImpl.calls).toHaveLength(1);
      expect(result).toMatchObject({ kind: "reply_run", jobId: "job_7", status: "completed", project: "proj-c", ticket: "T-3", sessionId: "sess-9" });
    });

    it("can pause again on a FOLLOW-UP conversational hearing", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_8", status: "running" } });
      const awaitSettle = makeAwaitSettle({
        item: settle({ jobId: "job_8", status: "awaiting-user-input", inputKind: "conversational", hearing: "Which region?", runSessionId: "sess-9", pendingTask: "plan-todo" })
      });
      const result = await replyRun({ project: "p", ticket: "t", sessionId: "sess-9", answer: "yes", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle });
      expect(result.inputKind).toBe("conversational");
      expect(result.hearing).toBe("Which region?");
      expect(result.sessionId).toBe("sess-9");
    });

    it("throws when project / ticket / sessionId / answer is missing (before any fetch)", async () => {
      const fetchImpl = makeFetch();
      await expect(replyRun({ ticket: "t", sessionId: "s", answer: "a", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/project is required/);
      await expect(replyRun({ project: "p", sessionId: "s", answer: "a", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/ticket is required/);
      await expect(replyRun({ project: "p", ticket: "t", answer: "a", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/sessionId is required/);
      await expect(replyRun({ project: "p", ticket: "t", sessionId: "s", answer: "   ", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/answer is required/);
      expect(fetchImpl.calls).toHaveLength(0);
    });

    it("throws with status + body on a non-OK response", async () => {
      const fetchImpl = makeFetch({ ok: false, status: 400, statusText: "Bad Request", text: JSON.stringify({ data: { error: { message: "answer は必須です" } } }) });
      await expect(replyRun({ project: "p", ticket: "t", sessionId: "s", answer: "a", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/reply_run failed: 400.*answer は必須です/);
    });
  });

  // ADR 0038 D1 — the run ⇄ conversation attach. conversationId is supplied by
  // the HOST (the tool dispatcher passes the owning AgentSession id), never by
  // the model: it is deliberately absent from the tool schemas so it cannot be
  // forged in tool arguments. It rides on the job-start POST body only.
  describe("conversationId attach (ADR 0038 D1)", () => {
    const bodyOf = (fetchImpl) => JSON.parse(fetchImpl.calls[0].init.body);
    const settled = () => makeAwaitSettle({ item: settle() });

    it("start_run puts the host-supplied conversationId on the POST body", async () => {
      const fetchImpl = makeSeqFetch();
      await startRun({ project: "p", ticket: "t", conversationId: "2026-07-26T00-00-00-000Z", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle: settled() });
      expect(bodyOf(fetchImpl)).toEqual({ project: "p", ticket: "t", conversationId: "2026-07-26T00-00-00-000Z" });
    });

    it("omits conversationId entirely when absent or blank (old-dashboard compatible)", async () => {
      for (const conversationId of [undefined, "", "   ", null, 42]) {
        const fetchImpl = makeSeqFetch();
        await startRun({ project: "p", ticket: "t", conversationId, dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle: settled() });
        expect(bodyOf(fetchImpl)).toEqual({ project: "p", ticket: "t" });
      }
    });

    it("resume_run re-declares the attach (a resume mints a NEW jobId)", async () => {
      const fetchImpl = makeSeqFetch();
      await resumeRun({ project: "p", ticket: "t", conversationId: "conv-x", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle: settled() });
      expect(bodyOf(fetchImpl)).toEqual({ project: "p", ticket: "t", conversationId: "conv-x" });

      const bare = makeSeqFetch();
      await resumeRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: bare, awaitSettle: settled() });
      expect(bodyOf(bare)).toEqual({ project: "p", ticket: "t" });
    });

    it("reply_run carries the CONVERSATION id alongside the paused worker sessionId", async () => {
      const fetchImpl = makeSeqFetch();
      await replyRun({ project: "p", ticket: "t", sessionId: "worker-sess", answer: "yes", conversationId: "conv-x", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, awaitSettle: settled() });
      expect(bodyOf(fetchImpl)).toEqual({ project: "p", ticket: "t", sessionId: "worker-sess", answer: "yes", conversationId: "conv-x" });
    });
  });

  /**
   * Two JOINs at once, against the REAL supervisor. Under the poll this was two
   * interleaved 2s loops; as an event wait it is two independent waiters, and
   * `attach_run` stays READ-ONLY (tools/registry READ_ONLY_TOOLS) precisely so
   * the scheduler does not serialize them into each other.
   */
  describe("two runs joined at the same time (real wake supervisor)", () => {
    it("resolves each JOIN with ITS OWN run's settle, in whatever order they arrive", async () => {
      const supervisor = createWakeSupervisor({
        sessionId: "s1",
        registry: new DelegatedJobRegistry(),
        injectTurn: async () => {}
      }).start();
      const awaitSettle = (jobId, opts) => supervisor.awaitSettle(jobId, opts);

      const first = attachRun({ runId: "run_A", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: makeSeqFetch(), awaitSettle });
      const second = attachRun({ runId: "run_B", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl: makeSeqFetch(), awaitSettle });
      // Let both waiters register before the settles arrive.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Second run settles FIRST — the JOINs must not be coupled.
      supervisor.pushExternal({ jobId: "run_B", status: "completed", project: "p", ticket: "T-B" });
      supervisor.pushExternal({ jobId: "run_A", status: "awaiting-user-input", inputKind: "conversational", hearing: "Which DB?", project: "p", ticket: "T-A" });

      const [a, b] = await Promise.all([first, second]);
      expect(a).toMatchObject({ jobId: "run_A", status: "awaiting-user-input", hearing: "Which DB?", ticket: "T-A" });
      expect(b).toMatchObject({ jobId: "run_B", status: "completed", ticket: "T-B" });
      // Neither settle is left queued as a wake: the JOINs delivered them.
      expect(supervisor.__inspect().pending).toEqual([]);
      supervisor.stop();
    });
  });
});
