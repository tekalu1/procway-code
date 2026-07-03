// Regression test for the runTurn re-entrancy guard (AgentSession.runTurn).
//
// A single AgentSession instance is shared across every WS connection to the
// same conversation (serve liveSessions cache), and a dropped socket does NOT
// abort an in-flight turn. Before the guard, a second runTurn that overlapped
// the first ran CONCURRENTLY on the one instance: both turns streamed and
// emitted assistant.message.delta onto the shared EventBus, the bridge forwarded
// both, and the client concatenated the interleaved copies — surfacing as
// tripled/garbled text ("修修修正正正…") and the same tool firing repeatedly.
//
// The guard rejects the second turn up front, BEFORE touching the live turn's
// turnAbortController / runningTurn. Uses the cli-agent-hang fixture (consumes
// its request and never responds) to keep turn 1 in flight while we attempt the
// overlap, then aborts turn 1 to settle.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";

const hangBin = fileURLToPath(new URL("./fixtures/cli-agent-hang.mjs", import.meta.url));

describe("AgentSession.runTurn re-entrancy guard", () => {
  let savedIdle;
  beforeEach(() => { savedIdle = process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS; });
  afterEach(() => {
    if (savedIdle === undefined) delete process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS;
    else process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS = savedIdle;
  });

  it("rejects a second runTurn while one is in flight, without disturbing the live turn", async () => {
    // Disable the idle watchdog so turn 1 stays in flight until we abort it.
    process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS = "0";
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-reentry-"));
    const session = new AgentSession({
      settings: {
        defaultProvider: "hang-agent",
        approvalMode: "auto-readonly",
        agents: { defaultTimeoutMs: 30_000 },
        tools: { maxToolRounds: 1, maxParallelTools: 1 },
        providers: { "hang-agent": { type: "cli-agent", command: process.execPath, args: [hangBin], stdinMode: "json" } },
        session: { enabled: false }
      },
      cwd,
      sessionId: "s-reentry-1",
      events: new EventBus()
    });
    await session.initialize();
    session.messages = [];

    // Turn 1: do not await — it hangs (provider never responds) until we abort.
    const turn1 = session.runTurn("first").catch(() => {});
    // Wait until the live turn has actually started.
    while (!session.runningTurn) await new Promise((r) => setTimeout(r, 5));
    const liveController = session.turnAbortController;

    // Turn 2 must be rejected with the typed code...
    let caught;
    try {
      await session.runTurn("second");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("TURN_IN_PROGRESS");

    // ...and must NOT have clobbered the live turn's abort controller or flag —
    // proving the guard short-circuits before any per-turn state mutation.
    expect(session.turnAbortController).toBe(liveController);
    expect(session.runningTurn).toBe(true);

    // Tear down: abort the live turn and let it settle.
    session.abort();
    await turn1;
    expect(session.runningTurn).toBe(false);

    await rm(cwd, { recursive: true, force: true });
  }, 20_000);
});
