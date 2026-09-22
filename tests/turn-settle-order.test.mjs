// Issue #163: the end of a turn must be announced only once the turn is really
// over. `turn.completed` used to be emitted BEFORE the turn's final
// `save({ force: true })`, and `runningTurn` only dropped after that save — so
// for as long as the save took (15-20 ms on a Windows runner with an AV scanner
// holding the new file), a host that reacted to `turn.completed` found:
//   - `runningTurn === true` → its next `runTurn` bounced with `turn_in_progress`
//   - a snapshot on disk that did not contain the answer yet
//   - a `steer` still accepted ("parked") by a turn that would never read it.
// These tests stretch that save so the window is wide open, whatever the disk.
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { attachBridge } from "../src/adapters/serve/bridge.mjs";

const SLOW_SAVE_MS = 40;
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function makeSession({ maxToolRounds = 6, approvalMode = "full-auto" } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-settle-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const session = new AgentSession({
    sessionId: `settle-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    cwd,
    wake: false,
    events: new EventBus(),
    settings: {
      approvalMode,
      tools: { maxParallelTools: 1, maxToolRounds },
      session: { enabled: false },
      agents: {}
    }
  });
  await session.initialize();
  return session;
}

/**
 * Make every forced save slow, and remember what each finished save covered.
 * `onForcedSave` runs when a forced save STARTS (i.e. while it is in flight).
 */
function slowSaves(session, { onForcedSave = null } = {}) {
  const save = session.save.bind(session);
  const finished = [];
  session.save = async (options = {}) => {
    if (options.force) {
      onForcedSave?.();
      const assistantCount = session.messages.filter((m) => m.role === "assistant").length;
      await new Promise((resolve) => setTimeout(resolve, SLOW_SAVE_MS));
      const result = await save(options);
      finished.push({ assistantCount });
      return result;
    }
    return save(options);
  };
  return finished;
}

const reply = (text) => ({ message: { role: "assistant", content: text }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } });
const writeCall = () => ({
  message: { role: "assistant", content: "" },
  toolCalls: [{ id: "write1", name: "write_file", args: { filePath: "note.txt", content: "hello" } }],
  usage: {}
});

/** A fake serve socket: `onFrame` sees each frame the way a host would, asynchronously. */
function socket(session, onFrame = null) {
  const ws = new EventEmitter();
  const frames = [];
  const command = (commandName, args) => {
    const id = Math.random().toString(36).slice(2);
    ws.emit("message", JSON.stringify({ kind: "command", id, command: commandName, args }));
    return id;
  };
  ws.send = (raw) => {
    const frame = JSON.parse(raw);
    frames.push(frame);
    // A host receives frames over the network: react in a later macrotask.
    if (onFrame) setImmediate(() => onFrame(frame, command));
  };
  const bridge = attachBridge({ session, ws });
  cleanups.push(() => bridge.detach());
  const response = async (id) => {
    await expect.poll(() => frames.find((f) => f.kind === "response" && f.id === id), { timeout: 5000 }).toBeTruthy();
    return frames.find((f) => f.kind === "response" && f.id === id);
  };
  return { frames, command, response };
}

describe("turn end ordering (#163)", () => {
  it("has the answer saved and runningTurn released by the time turn.completed is seen", async () => {
    const session = await makeSession();
    const finished = slowSaves(session);
    const seen = [];
    session.events.on("turn.completed", () => {
      const savedAnswer = finished.some((s) => s.assistantCount >= 1);
      // What a host acting on the event over the wire would observe.
      setImmediate(() => seen.push({ savedAnswer, runningTurn: session.runningTurn }));
    });

    await session.runTurn("hello", { runProviderImpl: async () => reply("hi") });

    expect(seen).toEqual([{ savedAnswer: true, runningTurn: false }]);
  });

  it("releases runningTurn before announcing a turn folded on a parked approval", async () => {
    const session = await makeSession({ approvalMode: "always-ask" });
    slowSaves(session);
    const seen = [];
    session.events.on("turn.completed", () => setImmediate(() => seen.push(session.runningTurn)));

    const result = await session.runTurn("write a file", { runProviderImpl: async () => writeCall() });

    expect(result.paused).toBe(true);
    expect(session.listParkedApprovals()).toHaveLength(1);
    expect(seen).toEqual([false]);
  });

  it("accepts a runTurn a host sends as soon as it sees the final turn.completed", async () => {
    const session = await makeSession();
    slowSaves(session);
    const followUps = [];
    const host = socket(session, (frame, command) => {
      if (frame.kind === "event" && frame.event?.type === "turn.completed" && !frame.event.continuing && followUps.length === 0) {
        followUps.push(command("runTurn", { prompt: "next" }));
      }
    });
    const provider = async () => reply("ok");
    // The provider seam is not a wire option; inject it below the bridge.
    const originalRunTurn = session.runTurn.bind(session);
    session.runTurn = (prompt, options = {}) => originalRunTurn(prompt, { ...options, runProviderImpl: provider });

    const first = host.command("runTurn", { prompt: "first" });
    expect((await host.response(first)).ok).toBe(true);
    await expect.poll(() => followUps.length).toBe(1);
    const second = await host.response(followUps[0]);
    expect(second).toMatchObject({ ok: true });
    await expect.poll(() => session.promptQueue.active).toBe(false);
    expect(session.messages.filter((m) => m.role === "user").map((m) => m.content[0].text)).toEqual(["first", "next"]);
  });

  it("answers a runTurn that races the lease tail with a structured turn_in_progress", async () => {
    const session = await makeSession();
    slowSaves(session);
    const rejected = [];
    const host = socket(session, (frame, command) => {
      // A host that (against the v2 contract) acts on the intermediate frame.
      if (frame.kind === "event" && frame.event?.type === "turn.completed" && frame.event.continuing && rejected.length === 0) {
        rejected.push(command("runTurn", { prompt: "too early" }));
      }
    });
    const provider = async () => reply("ok");
    const originalRunTurn = session.runTurn.bind(session);
    session.runTurn = (prompt, options = {}) => originalRunTurn(prompt, { ...options, runProviderImpl: provider });

    const first = host.command("runTurn", { prompt: "first" });
    expect((await host.response(first)).ok).toBe(true);
    await expect.poll(() => rejected.length).toBe(1);
    const response = await host.response(rejected[0]);
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "turn_in_progress" });
  });
});

describe("steer racing the end of the turn (#163)", () => {
  it("folds a steer accepted during the final save into the same turn", async () => {
    const session = await makeSession();
    const events = [];
    session.events.on("*", (event) => events.push(event));
    let answered = false;
    let steered = null;
    slowSaves(session, {
      onForcedSave: () => {
        if (answered && steered === null) steered = session.steer("one more thing", { clientMessageId: "m-late" });
      }
    });
    let calls = 0;
    await session.runTurn("go", {
      runProviderImpl: async () => {
        calls += 1;
        answered = true;
        return reply(calls === 1 ? "first answer" : "answer to the late message");
      }
    });

    // Whatever the ack said, the message must not be stranded.
    expect(session.pendingSteer).toHaveLength(0);
    if (steered) {
      expect(calls).toBe(2);
      const folded = events.findIndex((e) => e.type === "user.prompt.submitted" && e.steer === true && e.clientMessageId === "m-late");
      const completed = events.findIndex((e) => e.type === "turn.completed");
      expect(folded).toBeGreaterThanOrEqual(0);
      expect(folded).toBeLessThan(completed);
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(events.some((e) => e.type === "steer.dropped")).toBe(false);
    }
    expect(steered).toBe(true);
  });

  it("announces steer.dropped when no round is left for a steer accepted during the final save", async () => {
    const session = await makeSession({ maxToolRounds: 1 });
    const events = [];
    session.events.on("*", (event) => events.push(event));
    let answered = false;
    let steered = null;
    slowSaves(session, {
      onForcedSave: () => {
        if (answered && steered === null) steered = session.steer("too late", { clientMessageId: "m-late" });
      }
    });
    let calls = 0;
    await session.runTurn("go", {
      runProviderImpl: async () => {
        // Round 0 calls a tool; round 1 is the last round this turn may run.
        if (++calls === 1) {
          return { message: { role: "assistant", content: "" }, toolCalls: [{ id: "tc-1", name: "list_dir", args: { path: "." } }], usage: {} };
        }
        answered = true;
        return reply("done");
      }
    });

    expect(calls).toBe(2);
    expect(steered).toBe(true);
    expect(session.pendingSteer).toHaveLength(0);
    const dropped = events.filter((e) => e.type === "steer.dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ reason: "tool_loop_exceeded", clientMessageIds: ["m-late"] });
  });

  it("announces steer.dropped for a steer accepted while an interrupted turn saves", async () => {
    const session = await makeSession();
    const events = [];
    session.events.on("*", (event) => events.push(event));
    let stopped = false;
    let steered = null;
    slowSaves(session, {
      onForcedSave: () => {
        if (stopped && steered === null) steered = session.steer("while stopping", { clientMessageId: "m-stop" });
      }
    });
    const result = await session.runTurn("go", {
      runProviderImpl: async () => {
        stopped = true;
        session.abort();
        return reply("never mind");
      }
    }).catch((error) => ({ thrown: error }));

    expect(result).toBeTruthy();
    expect(steered).toBe(true);
    expect(session.pendingSteer).toHaveLength(0);
    expect(events.filter((e) => e.type === "steer.dropped").flatMap((e) => e.clientMessageIds)).toContain("m-stop");
  });
});
