import { describe, expect, it } from "vitest";
import { startRun, getRunStatus, resumeRun, replyRun } from "../src/tools/run-control.mjs";

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
 * Sequencing fetch for ADR 0029 await-yield: a POST (start/resume/reply) returns
 * `post`; each subsequent GET poll returns the next entry of `polls` (last entry
 * repeats). Lets a test drive running→running→awaiting-user-input.
 */
function makeSeqFetch({ post = { jobId: "job_1", status: "running" }, polls = [{ jobId: "job_1", status: "completed" }], ok = true } = {}) {
  const calls = [];
  let pollIdx = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const method = init.method ?? "GET";
    const json = method === "GET" ? polls[Math.min(pollIdx++, polls.length - 1)] : post;
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

/** Instant sleep so await-yield resolves without real timers. */
const noSleep = () => Promise.resolve();

describe("run-control tool facade", () => {
  describe("startRun (await-yield)", () => {
    it("POSTs to /api/run/jobs, then polls until the job leaves running and returns the yield", async () => {
      const fetchImpl = makeSeqFetch({
        post: { jobId: "job_1", status: "running" },
        polls: [
          { jobId: "job_1", status: "running" },
          { jobId: "job_1", status: "running" },
          { jobId: "job_1", status: "awaiting-user-input", inputKind: "conversational", hearing: "Which DB?", result: { status: "awaiting-user-input", runs: [], sessionId: "sess-1", pendingTask: "plan-todo" } }
        ]
      });
      const result = await startRun({
        project: "proj-a",
        ticket: "T-9",
        autoApprove: true,
        dashboardUrl: DASH,
        proxyToken: TOKEN,
        fetchImpl,
        sleepImpl: noSleep
      });

      // 1 POST + 3 GET polls.
      expect(fetchImpl.calls).toHaveLength(4);
      const post = fetchImpl.calls[0];
      expect(post.url).toBe(`${DASH}/api/run/jobs`);
      expect(post.init.method).toBe("POST");
      expect(post.init.headers["x-procway-session"]).toBe(TOKEN);
      expect(post.init.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(post.init.body)).toEqual({ project: "proj-a", ticket: "T-9", autoApprove: true });

      const poll = fetchImpl.calls[1];
      expect(poll.url).toBe(`${DASH}/api/run/jobs/job_1`);
      expect(poll.init.method).toBeUndefined();
      expect(poll.init.headers["x-procway-session"]).toBe(TOKEN);

      expect(result).toEqual({
        kind: "start_run",
        jobId: "job_1",
        status: "awaiting-user-input",
        inputKind: "conversational",
        hearing: "Which DB?",
        sessionId: "sess-1",
        pendingTask: "plan-todo",
        result: { status: "awaiting-user-input", runs: [], sessionId: "sess-1", pendingTask: "plan-todo" },
        project: "proj-a",
        ticket: "T-9"
      });
    });

    it("surfaces a structured interaction yield (inputKind structured)", async () => {
      const fetchImpl = makeSeqFetch({
        polls: [{ jobId: "job_1", status: "awaiting-user-input", inputKind: "structured", interaction: { requestId: "r1", kind: "approval" }, result: { status: "awaiting-user-input", runs: [], interaction: { requestId: "r1", kind: "approval" } } }]
      });
      const result = await startRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, sleepImpl: noSleep });
      expect(result.inputKind).toBe("structured");
      expect(result.interaction).toEqual({ requestId: "r1", kind: "approval" });
      expect(result.hearing).toBeUndefined();
    });

    it("fires onProgress on every poll (turn-idle heartbeat)", async () => {
      const ticks = [];
      const fetchImpl = makeSeqFetch({
        polls: [
          { jobId: "job_1", status: "running" },
          { jobId: "job_1", status: "completed", result: { status: "completed", runs: [] } }
        ]
      });
      await startRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, sleepImpl: noSleep, onProgress: (p) => ticks.push(p) });
      expect(ticks.length).toBe(2);
      expect(ticks[0].detail).toMatch(/job_1: running/);
      expect(ticks[1].detail).toMatch(/job_1: completed/);
    });

    it("omits autoApprove when not a boolean and trims a trailing slash on the base URL", async () => {
      const fetchImpl = makeSeqFetch({ post: { jobId: "job_2", status: "running" }, polls: [{ jobId: "job_2", status: "completed" }] });
      await startRun({ project: "p", ticket: "t", dashboardUrl: `${DASH}/`, proxyToken: TOKEN, fetchImpl, sleepImpl: noSleep });
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

    it("throws with status + body message on a non-OK POST (before polling)", async () => {
      const fetchImpl = makeFetch({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: JSON.stringify({ statusMessage: "ジョブ開始中に予期しないエラー" })
      });
      await expect(startRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/start_run failed: 500.*ジョブ開始中に予期しないエラー/);
      expect(fetchImpl.calls).toHaveLength(1); // POST only, no poll
    });

    it("throws when the dashboard URL or proxy token is missing", async () => {
      const fetchImpl = makeFetch();
      await expect(startRun({ project: "p", ticket: "t", dashboardUrl: "", proxyToken: TOKEN, fetchImpl }))
        .rejects.toThrow(/PROCWAY_DASHBOARD_URL is not set/);
      await expect(startRun({ project: "p", ticket: "t", dashboardUrl: DASH, proxyToken: "", fetchImpl }))
        .rejects.toThrow(/PROCWAY_PROXY_TOKEN is not set/);
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
    it("POSTs to /api/run/jobs/resume, then polls and returns the yield", async () => {
      const fetchImpl = makeSeqFetch({
        post: { jobId: "job_5", status: "running" },
        polls: [{ jobId: "job_5", status: "completed", result: { status: "completed", runs: [] } }]
      });
      const result = await resumeRun({
        project: "proj-b",
        ticket: "T-2",
        dashboardUrl: DASH,
        proxyToken: TOKEN,
        fetchImpl,
        sleepImpl: noSleep
      });

      const post = fetchImpl.calls[0];
      expect(post.url).toBe(`${DASH}/api/run/jobs/resume`);
      expect(post.init.method).toBe("POST");
      expect(post.init.headers["x-procway-session"]).toBe(TOKEN);
      expect(JSON.parse(post.init.body)).toEqual({ project: "proj-b", ticket: "T-2" });
      expect(fetchImpl.calls[1].url).toBe(`${DASH}/api/run/jobs/job_5`);
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
    it("POSTs to /api/run/jobs/conversational-resume with sessionId+answer, then polls and returns the yield", async () => {
      const fetchImpl = makeSeqFetch({
        post: { jobId: "job_7", status: "running" },
        polls: [
          { jobId: "job_7", status: "running" },
          { jobId: "job_7", status: "completed", result: { status: "completed", runs: [], sessionId: "sess-9" } }
        ]
      });
      const result = await replyRun({
        project: "proj-c",
        ticket: "T-3",
        sessionId: "sess-9",
        answer: "Use Postgres.",
        dashboardUrl: DASH,
        proxyToken: TOKEN,
        fetchImpl,
        sleepImpl: noSleep
      });

      const post = fetchImpl.calls[0];
      expect(post.url).toBe(`${DASH}/api/run/jobs/conversational-resume`);
      expect(post.init.method).toBe("POST");
      expect(post.init.headers["x-procway-session"]).toBe(TOKEN);
      expect(post.init.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(post.init.body)).toEqual({ project: "proj-c", ticket: "T-3", sessionId: "sess-9", answer: "Use Postgres." });

      // 1 POST + 2 GET polls.
      expect(fetchImpl.calls).toHaveLength(3);
      expect(fetchImpl.calls[1].url).toBe(`${DASH}/api/run/jobs/job_7`);
      expect(result).toMatchObject({ kind: "reply_run", jobId: "job_7", status: "completed", project: "proj-c", ticket: "T-3", sessionId: "sess-9" });
    });

    it("can pause again on a FOLLOW-UP conversational hearing", async () => {
      const fetchImpl = makeSeqFetch({
        post: { jobId: "job_8", status: "running" },
        polls: [{ jobId: "job_8", status: "awaiting-user-input", inputKind: "conversational", hearing: "Which region?", result: { status: "awaiting-user-input", runs: [], sessionId: "sess-9", pendingTask: "plan-todo" } }]
      });
      const result = await replyRun({ project: "p", ticket: "t", sessionId: "sess-9", answer: "yes", dashboardUrl: DASH, proxyToken: TOKEN, fetchImpl, sleepImpl: noSleep });
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
});
