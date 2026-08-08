// S-5 end-to-end: one Ctrl+C, one message — whatever the turn was doing.
//
// The bug: a Stop that landed BETWEEN rounds returned "Turn interrupted by
// user", while the same Stop landing mid-stream leaked the transport's
// DOMException ("This operation was aborted"). Same key, two different
// messages, decided by timing. These drive a real AgentSession through both
// timings (plus a mid-TOOL one) and assert one message and one code.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { USER_INTERRUPT_MESSAGE, USER_INTERRUPT_CODE } from "../src/agent/abort.mjs";
import { toOpenAiMessages } from "../src/providers/format/openai.mjs";

let dirs = [];
let savedIdle;

beforeEach(() => { savedIdle = process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS; process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS = "0"; });
afterEach(async () => {
  if (savedIdle === undefined) delete process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS;
  else process.env.PROCWAY_TURN_IDLE_TIMEOUT_MS = savedIdle;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function makeSession(id) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-interrupt-"));
  dirs.push(cwd);
  const session = new AgentSession({
    settings: {
      defaultProvider: "scripted",
      approvalMode: "full-auto",
      tools: { maxToolRounds: 4, maxParallelTools: 2, shellTimeoutMs: 30_000 },
      providers: { scripted: { type: "openai-compatible", baseUrl: "https://example.test/v1", apiKeyEnv: "NOPE", defaultModel: "m" } },
      session: { enabled: false }
    },
    cwd,
    sessionId: id,
    events: new EventBus()
  });
  await session.initialize();
  const failures = [];
  session.events.on("turn.failed", (e) => failures.push(e));
  return { session, failures, cwd };
}

describe("AgentSession interrupt consistency", () => {
  it("reports the unified message when the Stop lands MID-STREAM", async () => {
    const { session, failures } = await makeSession("s-int-stream");
    let sawDelta = null;
    session.events.on("assistant.message.delta", (e) => { sawDelta = e; });

    const runProviderImpl = async ({ signal }) => ({
      deltaStream: (async function* () {
        yield { deltaText: "I am halfway through a " };
        // Hang like a live SSE stream until the signal fires, then reject with
        // the abort reason exactly as undici does.
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })(),
      finalize: async () => ({ message: { role: "assistant", content: "never" }, toolCalls: [] })
    });

    const turn = session.runTurn("hello", { runProviderImpl });
    for (let i = 0; i < 100 && !sawDelta; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(sawDelta).toBeTruthy();
    expect(session.abort()).toBe(true);

    const result = await turn;
    expect(result.error).toEqual({ message: USER_INTERRUPT_MESSAGE, code: USER_INTERRUPT_CODE });
    expect(failures.at(-1).error).toMatchObject({ message: USER_INTERRUPT_MESSAGE, code: USER_INTERRUPT_CODE });

    // S-6: the text the user already saw is in the transcript.
    const assistant = session.messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toEqual([{ kind: "text", text: "I am halfway through a " }]);
  });

  it("reports the SAME message when the Stop lands during a tool round", async () => {
    const { session, failures } = await makeSession("s-int-tool");
    let toolStarted = false;
    session.events.on("tool.call.started", () => { toolStarted = true; });

    let round = 0;
    const runProviderImpl = async () => {
      round += 1;
      if (round === 1) {
        return {
          message: { role: "assistant", content: null },
          toolCalls: [{ id: "call-1", name: "run_shell", args: { command: "sleep 20" } }],
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
      throw new Error("provider must not be called again after the interrupt");
    };

    const turn = session.runTurn("run something long", { runProviderImpl });
    for (let i = 0; i < 200 && !toolStarted; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(toolStarted).toBe(true);
    session.abort();

    const result = await turn;
    expect(result.error).toEqual({ message: USER_INTERRUPT_MESSAGE, code: USER_INTERRUPT_CODE });
    expect(failures.at(-1).error).toMatchObject({ message: USER_INTERRUPT_MESSAGE, code: USER_INTERRUPT_CODE });
    // The interrupted turn is still a valid conversation to re-send: the
    // assistant's tool_use has its paired tool_result.
    const wire = toOpenAiMessages(session.messages);
    const callIds = wire.filter((m) => Array.isArray(m.tool_calls)).flatMap((m) => m.tool_calls.map((c) => c.id));
    const answered = wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(callIds).toEqual(["call-1"]);
    expect(answered).toEqual(["call-1"]);
  }, 30_000);

  it("a Stop between rounds returns the identical shape", async () => {
    const { session, failures } = await makeSession("s-int-rounds");
    let round = 0;
    const runProviderImpl = async () => {
      round += 1;
      if (round === 1) {
        // Provider that ignores the signal: the abort requested here is only
        // noticed at the top of the NEXT round (the between-rounds path).
        session.abort();
        return { message: { role: "assistant", content: null }, toolCalls: [{ id: "call-x", name: "read_file", args: { path: "nope.txt" } }] };
      }
      throw new Error("provider must not be called again after the interrupt");
    };
    const result = await session.runTurn("go", { runProviderImpl });
    expect(result.error).toEqual({ message: USER_INTERRUPT_MESSAGE, code: USER_INTERRUPT_CODE });
    expect(failures.at(-1).error).toMatchObject({ message: USER_INTERRUPT_MESSAGE, code: USER_INTERRUPT_CODE });
  });

  it("a fresh turn after an interrupt is not pre-aborted", async () => {
    const { session } = await makeSession("s-int-reset");
    const abortingProvider = async () => {
      session.abort();
      return { message: { role: "assistant", content: null }, toolCalls: [{ id: "c1", name: "read_file", args: { path: "x" } }] };
    };
    await session.runTurn("first", { runProviderImpl: abortingProvider });
    expect(session.interruptRequested).toBe(false);

    const okProvider = async () => ({ message: { role: "assistant", content: "second answer" }, toolCalls: [] });
    const result = await session.runTurn("second", { runProviderImpl: okProvider });
    expect(result.error).toBeUndefined();
    expect(session.messages.at(-1).content).toEqual([{ kind: "text", text: "second answer" }]);
  });
});
