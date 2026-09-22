// Mid-turn user messages (serve `steer`).
//
// A message typed while a turn is running is parked on the session and folded
// into the conversation at the turn's next round boundary — before a model
// round, right after the previous round's tool results — so the model answers
// it INSIDE the turn. The `steer` ack only means "parked"; the fold is
// announced by `user.prompt.submitted` with `steer: true`, and a turn that
// dies before the next boundary says so with `steer.dropped`.
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";

async function makeSession({ maxToolRounds = 6 } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-steer-"));
  const session = new AgentSession({
    settings: {
      approvalMode: "full-auto",
      tools: { maxParallelTools: 1, maxToolRounds },
      session: { enabled: false },
      agents: {}
    },
    cwd,
    sessionId: "steer-1",
    events: new EventBus()
  });
  await session.initialize();
  session.cleanup = async () => rm(cwd, { recursive: true, force: true });
  return session;
}

/** Scripted provider: consumes one response per model round, records calls. */
function scriptedProvider(script) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return typeof step === "function" ? step(args) : step;
  };
  return { impl, calls };
}

const toolRound = (toolCalls) => ({
  message: { role: "assistant", content: "" },
  toolCalls,
  usage: { inputTokens: 0, outputTokens: 0 }
});
const finalRound = (text) => ({
  message: { role: "assistant", content: text },
  toolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0 }
});

/** The visible shape of the turn: one letter per message, in transcript order. */
function shape(session) {
  return session.messages
    .filter((m) => m.role !== "system")
    .map((m) => m.role[0])
    .join("");
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((b) => b?.kind === "text")
    .map((b) => b.text)
    .join("");
}

describe("steer (mid-turn user message)", () => {
  it("refuses to park anything when no turn is running", async () => {
    const session = await makeSession();
    try {
      expect(session.steer("too early", { clientMessageId: "m-1" })).toBe(false);
      expect(session.pendingSteer).toHaveLength(0);
      expect(() => session.steer("", {})).toThrow(/prompt is required/);
    } finally {
      await session.cleanup();
    }
  });

  it("folds a message parked during a tool round in right after that round's results", async () => {
    const session = await makeSession();
    try {
      const events = [];
      session.events.on("*", (event) => events.push(event));
      const provider = scriptedProvider([
        (args) => {
          // The user types while the first model round is in flight.
          expect(session.steer("and check the logs too", { clientMessageId: "m-7" })).toBe(true);
          expect(args).toBeTruthy();
          return toolRound([{ id: "tc-1", name: "list_dir", args: { path: "." } }]);
        },
        finalRound("done, and the logs are clean")
      ]);

      await session.runTurn("look around", { runProviderImpl: provider.impl });

      // user(turn) assistant(tool_use) tool(result) user(steer) assistant(final)
      expect(shape(session)).toBe("uatua");
      const steered = session.messages.filter((m) => m.role === "user")[1];
      expect(textOf(steered)).toBe("and check the logs too");
      // The steer message is a real user utterance — no `wake` mark, nothing a
      // display surface should hide.
      expect(steered.wake).toBeUndefined();

      const prompts = events.filter((e) => e.type === "user.prompt.submitted");
      expect(prompts).toHaveLength(2);
      expect(prompts[0].steer).toBeUndefined();
      expect(prompts[1]).toMatchObject({ steer: true, clientMessageId: "m-7", messageId: steered.id });
      expect(prompts[1].wake).toBeUndefined();

      // One turn, not two: the answer came inside the turn the user steered.
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(events.some((e) => e.type === "turn.failed")).toBe(false);
      expect(events.some((e) => e.type === "steer.dropped")).toBe(false);
      expect(session.pendingSteer).toHaveLength(0);
    } finally {
      await session.cleanup();
    }
  });

  it("takes one more round when the model finished without calling a tool", async () => {
    const session = await makeSession();
    try {
      const events = [];
      session.events.on("*", (event) => events.push(event));
      const provider = scriptedProvider([
        () => {
          session.steer("wait — also summarise it", { clientMessageId: "m-8" });
          return finalRound("here is the answer");
        },
        finalRound("and here is the summary")
      ]);

      await session.runTurn("explain this", { runProviderImpl: provider.impl });

      expect(provider.calls).toHaveLength(2);
      expect(shape(session)).toBe("uaua");
      expect(textOf(session.messages.at(-1))).toBe("and here is the summary");
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  it("preserves arrival order when several messages are parked", async () => {
    const session = await makeSession();
    try {
      const provider = scriptedProvider([
        () => {
          session.steer("first", { clientMessageId: "m-1" });
          session.steer("second", { clientMessageId: "m-2" });
          return finalRound("ok");
        },
        finalRound("ok ok")
      ]);
      await session.runTurn("go", { runProviderImpl: provider.impl });
      const said = session.messages.filter((m) => m.role === "user").map(textOf);
      expect(said).toEqual(["go", "first", "second"]);
    } finally {
      await session.cleanup();
    }
  });

  it("announces steer.dropped when the turn is interrupted before the next boundary", async () => {
    const session = await makeSession();
    try {
      const events = [];
      session.events.on("*", (event) => events.push(event));
      const provider = scriptedProvider([
        () => {
          session.steer("never read", { clientMessageId: "m-9" });
          session.abort();
          return finalRound("answering the original question");
        }
      ]);

      const result = await session.runTurn("go", { runProviderImpl: provider.impl });

      expect(result.error?.code).toBeTruthy();
      const dropped = events.filter((e) => e.type === "steer.dropped");
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({ reason: "interrupted", count: 1, clientMessageIds: ["m-9"] });
      expect(session.pendingSteer).toHaveLength(0);
      // Nothing was folded in, so nothing claims it was delivered.
      expect(events.filter((e) => e.type === "user.prompt.submitted" && e.steer === true)).toHaveLength(0);
    } finally {
      await session.cleanup();
    }
  });

  it("announces steer.dropped when the round budget leaves no room for the extra round", async () => {
    const session = await makeSession({ maxToolRounds: 1 });
    try {
      const events = [];
      session.events.on("*", (event) => events.push(event));
      const provider = scriptedProvider([
        toolRound([{ id: "tc-1", name: "list_dir", args: { path: "." } }]),
        () => {
          // Round 1 is the last one this turn may run.
          session.steer("too late", { clientMessageId: "m-10" });
          return finalRound("done");
        }
      ]);

      await session.runTurn("go", { runProviderImpl: provider.impl });

      expect(provider.calls).toHaveLength(2);
      const dropped = events.filter((e) => e.type === "steer.dropped");
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({ reason: "tool_loop_exceeded", clientMessageIds: ["m-10"] });
    } finally {
      await session.cleanup();
    }
  });
});
