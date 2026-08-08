// Ctrl+C / Stop must actually stop things (S-1 … S-6).
//
// Before this, `session.abort()` flipped a flag and aborted a controller whose
// signal died at the orchestrator boundary: the model kept streaming (and
// billing), running tools kept running, and shell grandchildren were orphaned.
// These tests pin the signal to the two ends it must reach — the provider's
// `fetch` and a real process group — plus the two user-visible consequences:
// one consistent interrupt message, and a transcript that can be re-sent.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runOpenAiCompatibleProvider } from "../src/providers/openai-compatible.mjs";
import { runAnthropicProvider } from "../src/providers/anthropic.mjs";
import { runToolCalls } from "../src/agent/scheduler.mjs";
import { runShell } from "../src/tools/shell.mjs";
import { createChildAgentManager } from "../src/agent/child-agent.mjs";
import { executeModelRound, describeTurnAbort } from "../src/agent/turn-orchestrator.mjs";
import { createUserInterruptAbort, USER_INTERRUPT_MESSAGE, anySignal } from "../src/agent/abort.mjs";
import { toOpenAiMessages } from "../src/providers/format/openai.mjs";
import { EventBus } from "../src/core/events/bus.mjs";

/** A Response-ish object whose body is an endless SSE stream (never closes) —
 *  the shape a live model stream has while the user hits Ctrl+C. */
function makeEndlessSseResponse({ firstChunk = "data: {}\n\n" } = {}) {
  let delivered = false;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (!delivered) {
              delivered = true;
              return { value: new TextEncoder().encode(firstChunk), done: false };
            }
            // Never settles — only an abort can end this loop.
            return new Promise(() => {});
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    },
    text: async () => ""
  };
}

describe("S-1: the provider fetch receives the turn's AbortSignal", () => {
  beforeAll(() => { process.env.ABORT_TEST_KEY = "test-key"; });
  afterAll(() => { delete process.env.ABORT_TEST_KEY; });

  it("openai-compatible passes the signal to fetch and aborts the SSE loop", async () => {
    const controller = new AbortController();
    let seenInit = null;
    const fetchImpl = vi.fn(async (_url, init) => {
      seenInit = init;
      return makeEndlessSseResponse();
    });

    const response = await runOpenAiCompatibleProvider({
      provider: { type: "openai-compatible", baseUrl: "https://example.test/v1", apiKeyEnv: "ABORT_TEST_KEY" },
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      signal: controller.signal
    });

    // The exact signal object reached the HTTP layer …
    expect(seenInit.signal).toBe(controller.signal);
    expect(seenInit.signal.aborted).toBe(false);

    // … and aborting it unblocks the otherwise-endless stream.
    const finalized = response.finalize();
    controller.abort(createUserInterruptAbort());
    expect(seenInit.signal.aborted).toBe(true);
    await expect(finalized).rejects.toThrow(USER_INTERRUPT_MESSAGE);
  });

  it("anthropic passes the signal to fetch and aborts the SSE loop", async () => {
    const controller = new AbortController();
    let seenInit = null;
    const fetchImpl = vi.fn(async (_url, init) => {
      seenInit = init;
      return makeEndlessSseResponse({ firstChunk: "event: ping\ndata: {}\n\n" });
    });

    const response = await runAnthropicProvider({
      provider: { type: "anthropic", baseUrl: "https://example.test", apiKeyEnv: "ABORT_TEST_KEY" },
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      signal: controller.signal
    });

    expect(seenInit.signal).toBe(controller.signal);
    const finalized = response.finalize();
    controller.abort(createUserInterruptAbort());
    expect(seenInit.signal.aborted).toBe(true);
    await expect(finalized).rejects.toThrow(USER_INTERRUPT_MESSAGE);
  });

  it("an aborted turn is never retried by the provider's retry loop", async () => {
    const controller = new AbortController();
    controller.abort(createUserInterruptAbort());
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }); });

    await expect(runOpenAiCompatibleProvider({
      provider: { type: "openai-compatible", baseUrl: "https://example.test/v1", apiKeyEnv: "ABORT_TEST_KEY", maxRetries: 3 },
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      sleepImpl: async () => {},
      stream: false,
      signal: controller.signal
    })).rejects.toThrow(USER_INTERRUPT_MESSAGE);
    // ECONNRESET is normally retried 4x; a stopped turn must not re-dial at all.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("S-2: tool execution is interruptible", () => {
  it("settles a running tool as interrupted and never starts the queued ones", async () => {
    const controller = new AbortController();
    const started = [];
    const makeCall = (index, run) => ({ index, id: `c${index}`, name: "stub", mutation: false, run });

    const calls = [
      // Mutations run SEQUENTIALLY, so #2 is still queued when #1 is aborted.
      { ...makeCall(0, () => { started.push(0); return new Promise(() => {}); }), mutation: true },
      { ...makeCall(1, () => { started.push(1); return "never"; }), mutation: true }
    ];

    const resultsPromise = runToolCalls(calls, { timeoutMs: 60_000, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort(createUserInterruptAbort());
    const results = await resultsPromise;

    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results.every((r) => r.interrupted === true)).toBe(true);
    expect(results.every((r) => r.error === USER_INTERRUPT_MESSAGE)).toBe(true);
    // Call #1 ran (and was cut short); call #2 was never started.
    expect(started).toEqual([0]);
  });

  it("still returns a result for EVERY scheduled call (transcript stays pairable)", async () => {
    const controller = new AbortController();
    controller.abort(createUserInterruptAbort());
    const calls = [0, 1, 2].map((index) => ({
      index,
      id: `c${index}`,
      name: "stub",
      mutation: false,
      run: () => new Promise(() => {})
    }));
    const results = await runToolCalls(calls, { signal: controller.signal });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.id)).toEqual(["c0", "c1", "c2"]);
  });

  it("behaves exactly as before when no signal is supplied", async () => {
    const results = await runToolCalls(
      [{ index: 0, id: "c0", name: "stub", mutation: false, run: async () => "ok" }],
      { timeoutMs: 1000 }
    );
    expect(results[0]).toMatchObject({ ok: true, result: "ok" });
  });
});

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("S-3: run_shell kills the whole process group", () => {
  /** True while `pid` is alive (signal 0 probes without delivering). */
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it("abort kills the shell AND its background grandchild", async () => {
    const controller = new AbortController();
    let pid = null;
    // `sleep 30 &` forks a GRANDCHILD of the agent (child of the shell). The
    // old child.kill() never reached it — it outlived the "stopped" tool.
    const promise = runShell({
      command: "sleep 30 & echo GRANDCHILD=$!; wait",
      cwd: process.cwd(),
      timeoutMs: 30_000,
      signal: controller.signal,
      onProgress: ({ detail }) => {
        const match = /GRANDCHILD=(\d+)/.exec(detail ?? "");
        if (match && pid == null) pid = Number(match[1]);
      }
    });

    // Wait for the grandchild's pid to surface on the progress channel.
    for (let i = 0; i < 100 && pid == null; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);

    controller.abort(createUserInterruptAbort());
    const result = await promise;

    expect(result.kind).toBe("run_shell");
    expect(result.data.interrupted).toBe(true);
    expect(result.summary).toContain(USER_INTERRUPT_MESSAGE);

    // The grandchild is gone (allow a few ms for the signal to be reaped).
    for (let i = 0; i < 100 && alive(pid); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive(pid)).toBe(false);
  }, 20_000);

  it("timeout kills the grandchild too (same termination path)", async () => {
    let pid = null;
    const result = await runShell({
      command: "sleep 30 & echo GRANDCHILD=$!; wait",
      cwd: process.cwd(),
      timeoutMs: 300,
      onProgress: ({ detail }) => {
        const match = /GRANDCHILD=(\d+)/.exec(detail ?? "");
        if (match && pid == null) pid = Number(match[1]);
      }
    });
    expect(result.data.timedOut).toBe(true);
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 100 && alive(pid); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive(pid)).toBe(false);
  }, 20_000);

  it("an already-aborted signal never spawns a process at all", async () => {
    const controller = new AbortController();
    controller.abort(createUserInterruptAbort());
    const result = await runShell({
      command: "echo should-not-run",
      cwd: process.cwd(),
      signal: controller.signal
    });
    expect(result.data.interrupted).toBe(true);
    expect(result.data.stdout).toBe("");
  });
});

describe("S-4: the parent turn's Stop reaches a child agent", () => {
  it("aborting parentSignal aborts the signal the child session receives", async () => {
    const parent = new AbortController();
    const registryKill = new AbortController();
    let childSignal = null;
    const manager = createChildAgentManager({
      cwd: process.cwd(),
      settings: { agents: { maxDepth: 3, maxConcurrentAgents: 2 } },
      runAgentImpl: async ({ signal }) => {
        childSignal = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { exitCode: 0, text: "stopped" };
      }
    });

    const run = manager.run({
      task: "t",
      depth: 0,
      // The delegated-job registry's own kill switch …
      signal: registryKill.signal,
      // … plus the parent turn's Stop. Either must reach the child.
      parentSignal: parent.signal
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(childSignal).toBeTruthy();
    expect(childSignal.aborted).toBe(false);
    parent.abort(createUserInterruptAbort());
    await run;
    expect(childSignal.aborted).toBe(true);
  });

  it("anySignal keeps working when only one source exists", () => {
    const only = new AbortController();
    expect(anySignal([undefined, only.signal])).toBe(only.signal);
    expect(anySignal([undefined, null])).toBeUndefined();
  });
});

function makeOrchestratorSession() {
  const events = new EventBus();
  const observed = [];
  events.on("*", (event) => observed.push(event));
  const turnAbortController = new AbortController();
  return {
    observed,
    session: {
      sessionId: "abort-prop",
      messages: [],
      tools: [],
      cwd: process.cwd(),
      settings: {},
      events,
      turnAbortController,
      interruptRequested: false
    },
    turnAbortController
  };
}

describe("S-5 / S-6: interrupt wording and the surviving transcript", () => {
  it("maps a mid-stream user abort to the same message as a between-rounds one", () => {
    const { session, turnAbortController } = makeOrchestratorSession();
    session.interruptRequested = true;
    turnAbortController.abort(createUserInterruptAbort());
    // A raw DOMException-style abort error from the transport …
    const raw = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const mapped = describeTurnAbort(session, raw);
    expect(mapped).toMatchObject({ message: USER_INTERRUPT_MESSAGE, code: "interrupted", userAbort: true });
  });

  it("keeps the idle-watchdog message distinct from a user Stop", () => {
    const { session, turnAbortController } = makeOrchestratorSession();
    session.turnIdleAborted = true;
    turnAbortController.abort({ name: "IdleWatchdogAbort", idleMs: 180_000 });
    const mapped = describeTurnAbort(session, new Error("aborted"));
    expect(mapped.idleAbort).toBe(true);
    expect(mapped.code).toBe("idle_timeout");
  });

  it("commits the partial assistant text to session.messages on abort", async () => {
    const { session, observed, turnAbortController } = makeOrchestratorSession();
    const runProviderImpl = async () => ({
      deltaStream: (async function* () {
        yield { deltaText: "half a thou" };
        turnAbortController.abort(createUserInterruptAbort());
        throw turnAbortController.signal.reason;
      })(),
      finalize: async () => ({})
    });

    await expect(executeModelRound({ session, round: 0, runProviderImpl })).rejects.toThrow();

    // History matches what the screen already showed.
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("assistant");
    expect(session.messages[0].content).toEqual([{ kind: "text", text: "half a thou" }]);

    // …and it was announced so replay/resume rebuilds it, BEFORE turn.failed.
    const types = observed.map((e) => e.type);
    expect(types.indexOf("assistant.message.completed")).toBeGreaterThan(-1);
    expect(types.indexOf("assistant.message.completed")).toBeLessThan(types.indexOf("turn.failed"));
    const failure = observed.find((e) => e.type === "turn.failed");
    expect(failure.error.message).toBe(USER_INTERRUPT_MESSAGE);
  });

  it("does NOT commit a partial message for a non-abort failure (unchanged behavior)", async () => {
    const { session } = makeOrchestratorSession();
    const runProviderImpl = async () => ({
      deltaStream: (async function* () {
        yield { deltaText: "oops" };
        throw Object.assign(new Error("network down"), { code: "ECONNRESET" });
      })(),
      finalize: async () => ({})
    });
    await expect(executeModelRound({ session, round: 0, runProviderImpl })).rejects.toThrow("network down");
    expect(session.messages).toHaveLength(0);
  });

  it("the interrupted transcript is still valid to re-send to a provider", async () => {
    const { session, turnAbortController } = makeOrchestratorSession();
    session.messages.push({
      role: "user",
      content: [{ kind: "text", text: "do a thing" }]
    });
    // An interrupted tool round: the assistant asked for a tool and the
    // scheduler settled it as interrupted, so the pair is complete.
    session.messages.push({
      role: "assistant",
      content: [{ kind: "tool_use", toolCallId: "call-1", name: "run_shell", args: { command: "sleep 30" } }]
    });
    session.messages.push({
      role: "tool",
      toolCallId: "call-1",
      content: [{
        kind: "tool_result",
        toolCallId: "call-1",
        ok: false,
        result: { kind: "run_shell", summary: USER_INTERRUPT_MESSAGE, data: { interrupted: true } }
      }]
    });
    // Then the model round after it was cut mid-stream — text only, never a
    // dangling tool_call (finalize() is what produces tool_calls, and an abort
    // skips it).
    const runProviderImpl = async () => ({
      deltaStream: (async function* () {
        yield { deltaText: "resuming…" };
        turnAbortController.abort(createUserInterruptAbort());
        throw turnAbortController.signal.reason;
      })(),
      finalize: async () => ({})
    });
    await expect(executeModelRound({ session, round: 1, runProviderImpl })).rejects.toThrow();

    const wire = toOpenAiMessages(session.messages);
    const callIds = wire
      .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
      .flatMap((m) => m.tool_calls.map((c) => c.id));
    const answeredIds = wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    // Every tool_call has its result, and no assistant message is empty.
    expect(callIds.sort()).toEqual(answeredIds.sort());
    for (const message of wire) {
      if (message.role !== "assistant") continue;
      const hasContent = typeof message.content === "string" ? message.content.length > 0 : message.content != null;
      expect(hasContent || (message.tool_calls?.length ?? 0) > 0).toBe(true);
    }
  });
});
