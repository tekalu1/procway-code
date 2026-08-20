import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { createAgentSession } from "../src/core/index.mjs";
import {
  createToolLoopExceededResponse,
  executeModelRound,
  executeToolsRound,
  handleModelResponseWithoutTools,
  isToolRoundAllowed,
  toolCallBudgetMs
} from "../src/agent/turn-orchestrator.mjs";
import { DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS } from "../src/safety/command-classifier.mjs";
import { joinTimeoutMsFor } from "../src/tools/run-control.mjs";
import { DEFAULT_SETTINGS } from "../src/config/default-settings.mjs";
import { makeInvalidToolArgs } from "../src/providers/format/tool-args.mjs";

const echoBin = fileURLToPath(new URL("./fixtures/cli-agent-echo.mjs", import.meta.url));

function settingsForCliAgent() {
  return {
    defaultProvider: "echo-agent",
    defaultModel: "echo",
    approvalMode: "auto-readonly",
    agents: { defaultTimeoutMs: 5000, maxDepth: 1, maxConcurrentAgents: 1 },
    tools: { maxToolRounds: 1, maxParallelTools: 1 },
    providers: {
      "echo-agent": { type: "cli-agent", command: process.execPath, args: [echoBin], stdinMode: "json" }
    },
    mcpServers: {},
    session: { enabled: false },
    context: { compatibilityMode: "claude" }
  };
}

/**
 * Phase 4 (phase3_E-1 fix): the orchestrator tests now stand up a real
 * `AgentSession` rooted in a tmp cwd. The previous version relied on
 * `vi.fn(...)` to fake `save` and `executeSingleToolCall` — that violated
 * the project's "no mocks/stubs" rule. The session.enabled=false setting
 * keeps the persistence layer quiet without needing to swap implementations.
 */
async function makeSession({ executeSingleToolCallImpl } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-"));
  const events = new EventBus();
  const session = new AgentSession({
    settings: { tools: { maxParallelTools: 2 }, session: { enabled: false }, agents: {} },
    cwd,
    sessionId: "s-1",
    events
  });
  await session.initialize();
  // strip the auto-generated system message so test assertions read cleanly
  session.messages = [];
  const saveCalls = [];
  const originalSave = session.save.bind(session);
  session.save = async (...args) => {
    saveCalls.push(args);
    return originalSave(...args);
  };
  if (executeSingleToolCallImpl) {
    const calls = [];
    session.executeSingleToolCall = async (toolCall) => {
      calls.push(toolCall);
      return executeSingleToolCallImpl(toolCall);
    };
    session.executeSingleToolCallCalls = calls;
  }
  session.saveCalls = saveCalls;
  session.cleanup = async () => rm(cwd, { recursive: true, force: true });
  return session;
}

describe("turn orchestrator", () => {
  it("executes a real tool through the REAL executeSingleToolCall chain and reports ok:true", async () => {
    // Regression: the onProgress threading (activity.tick progress channel)
    // was added to executeSingleToolCall's signature but NOT to the private
    // #executeUnhookedToolCall it delegates to — every tool call in serve
    // failed with "ReferenceError: onProgress is not defined" while the
    // existing tool-round test stayed green because it only asserted event
    // ORDER, never the result's ok flag. This test pins ok:true through the
    // UNMOCKED chain: run() → executeSingleToolCall → #executeUnhookedToolCall
    // → registry.executeToolCall.
    const session = await makeSession(); // no executeSingleToolCallImpl — real chain
    try {
      await writeFile(path.join(session.cwd, "real.txt"), "hello", "utf8");
      const completed = [];
      session.events.on("tool.call.completed", (event) => completed.push(event));

      await executeToolsRound({
        session,
        round: 1,
        toolCalls: [{ id: "call-real-1", name: "read_file", args: { filePath: "real.txt" } }],
        response: { usage: { inputTokens: 1, outputTokens: 1 } }
      });

      expect(completed).toHaveLength(1);
      expect(completed[0].ok, `tool failed: ${JSON.stringify(completed[0].result?.summary)}`).toBe(true);
      expect(completed[0].result?.data?.content ?? completed[0].result?.data?.text ?? "").toContain("hello");
    } finally {
      await session.cleanup();
    }
  });

  it("item B: an invalid-args tool call executes as ok:false, but is recorded/emitted with sanitized {} args", async () => {
    const session = await makeSession(); // real executeSingleToolCall chain → validateToolArgs runs
    try {
      const scheduled = [];
      const completedEvents = [];
      const toolResultEvents = [];
      session.events.on("tool.call.scheduled", (e) => scheduled.push(e));
      session.events.on("assistant.message.completed", (e) => completedEvents.push(e));
      session.events.on("tool.call.completed", (e) => toolResultEvents.push(e));

      // The marker is a live object reference shared with the toolCall used for
      // execution; sanitizing the RECORD copies must not disturb it.
      const marker = makeInvalidToolArgs({ truncated: true });
      const toolResults = await executeToolsRound({
        session,
        round: 1,
        toolCalls: [{ id: "call-bad", name: "write_file", args: marker }],
        response: { usage: { inputTokens: 1, outputTokens: 1 } }
      });

      // (a) execution still saw the marker → clear ok:false result.
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].ok).toBe(false);
      expect(toolResults[0].error).toMatch(/write_file could not run because its arguments were truncated/);
      expect(toolResultEvents[0].ok).toBe(false);

      // (b) the persisted assistant message records sanitized {} args — no marker.
      const assistantMsg = session.messages.find((m) => m.role === "assistant");
      const toolUse = assistantMsg.content.find((b) => b.kind === "tool_use");
      expect(toolUse.args).toEqual({});
      expect(JSON.stringify(session.messages)).not.toContain("__procwayInvalidToolArgs");

      // (c) the emitted events carry sanitized args too — the marker never reaches the UI.
      expect(scheduled[0].args).toEqual({});
      const emittedToolUse = completedEvents[0].content.find((b) => b.kind === "tool_use");
      expect(emittedToolUse.args).toEqual({});
      expect(completedEvents[0].toolCalls[0].args).toEqual({});

      // (d) the paired ok:false tool_result is recorded alongside → model recovers next round.
      const toolMsg = session.messages.find((m) => m.role === "tool");
      const toolResultBlock = toolMsg.content.find((b) => b.kind === "tool_result");
      expect(toolResultBlock.ok).toBe(false);
    } finally {
      await session.cleanup();
    }
  });

  it("allows unlimited tool rounds when maxToolRounds is 0", () => {
    expect(isToolRoundAllowed(1000, 0)).toBe(true);
    expect(isToolRoundAllowed(51, 50)).toBe(false);
  });

  it("defaults maxToolRounds to 150 (WS-M: 50 was too few for heavy SaaS setup tasks)", () => {
    // The runtime container boots `serve` without --max-tool-rounds and the
    // dashboard settings.json does not propagate to the per-session workspace
    // volume, so this DEFAULT is the only lever that changes the SaaS cap.
    expect(DEFAULT_SETTINGS.tools.maxToolRounds).toBe(150);
  });

  it("respects the 150 boundary at the new default", () => {
    const cap = DEFAULT_SETTINGS.tools.maxToolRounds;
    expect(isToolRoundAllowed(cap, cap)).toBe(true);
    expect(isToolRoundAllowed(cap + 1, cap)).toBe(false);
  });

  it("creates the tool loop exceeded response", () => {
    expect(createToolLoopExceededResponse(6)).toEqual({
      error: { message: "Tool loop exceeded maxToolRounds (6)", code: "tool_loop_exceeded" }
    });
  });

  it("read-only toolPolicy hides mutation tools from the provider but keeps read tools", async () => {
    const session = await makeSession();
    try {
      session.activeToolPolicy = "read-only";
      let offeredTools = null;
      await executeModelRound({
        session,
        round: 0,
        turnMessageId: "m-1",
        runProviderImpl: async (args) => {
          offeredTools = args.tools.map((t) => t.function.name);
          return { message: { role: "assistant", content: "ok" }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
        }
      });
      expect(offeredTools).toContain("read_file");
      expect(offeredTools).not.toContain("write_file");
      expect(offeredTools).not.toContain("apply_patch");
      expect(offeredTools).not.toContain("run_shell");
    } finally {
      await session.cleanup();
    }
  });

  it("offers the full tool list when no toolPolicy is set", async () => {
    const session = await makeSession();
    try {
      let offeredTools = null;
      await executeModelRound({
        session,
        round: 0,
        turnMessageId: "m-1",
        runProviderImpl: async (args) => {
          offeredTools = args.tools.map((t) => t.function.name);
          return { message: { role: "assistant", content: "ok" }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
        }
      });
      expect(offeredTools).toContain("read_file");
      expect(offeredTools).toContain("write_file");
    } finally {
      await session.cleanup();
    }
  });

  it("forwards reasoning-tagged delta chunks as assistant.reasoning.delta events, not assistant.message.delta", async () => {
    const session = await makeSession();
    try {
      const events = [];
      session.events.on("assistant.message.delta", (e) => events.push({ type: "text", text: e.deltaText }));
      session.events.on("assistant.reasoning.delta", (e) => events.push({ type: "reasoning", text: e.deltaText }));

      async function* deltaStream() {
        yield { kind: "reasoning", deltaText: "I should " };
        yield { kind: "reasoning", deltaText: "do X" };
        yield { kind: "text", deltaText: "Doing X." };
      }
      const providerResponse = {
        deltaStream: deltaStream(),
        finalize: async () => ({ message: { role: "assistant", content: "Doing X." }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } })
      };

      await executeModelRound({
        session,
        round: 0,
        turnMessageId: "m-1",
        runProviderImpl: async () => providerResponse
      });

      expect(events).toEqual([
        { type: "reasoning", text: "I should " },
        { type: "reasoning", text: "do X" },
        { type: "text", text: "Doing X." }
      ]);
    } finally {
      await session.cleanup();
    }
  });

  it("emits turn.failed even when the provider throws BEFORE the first chunk (no infinite 'model waiting')", async () => {
    const session = await makeSession();
    try {
      const failed = [];
      let started = false;
      session.events.on("turn.failed", (e) => failed.push(e));
      session.events.on("assistant.message.started", () => { started = true; });

      // A provider request that stalls and then aborts (e.g. UND_ERR_BODY_TIMEOUT
      // after the request loop exhausts retries) throws BEFORE yielding any
      // delta or emitting assistant.message.started. The turn must STILL emit
      // turn.failed so the UI clears "model waiting" and can retry — gating it
      // on `started` previously left the chat hung forever in this case.
      const stall = Object.assign(new Error("Provider request timed out"), { code: "UND_ERR_BODY_TIMEOUT" });
      await expect(executeModelRound({
        session,
        round: 0,
        turnMessageId: "m-stall",
        runProviderImpl: async () => { throw stall; }
      })).rejects.toThrow(/timed out/);

      expect(started).toBe(false);   // never produced a chunk
      expect(failed).toHaveLength(1); // ...yet the turn failed loudly
      expect(failed[0].error.code).toBe("UND_ERR_BODY_TIMEOUT");
      expect(failed[0].round).toBe(0);
      expect(failed[0].partialContent).toBeUndefined(); // nothing partial pre-chunk
    } finally {
      await session.cleanup();
    }
  });

  it("appends final assistant responses, ends the turn, and emits assistant.message.completed", async () => {
    const session = await makeSession();
    try {
      const events = [];
      session.events.on("assistant.message.completed", (event) => events.push(event));

      const response = { message: { role: "assistant", content: "done" }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };

      const outcome = await handleModelResponseWithoutTools({
        session,
        response,
        needsFileMutation: false,
        turnStartIndex: 0,
        round: 0
      });

      expect(outcome).toEqual({ action: "return", response });
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual(expect.objectContaining({
        role: "assistant",
        sessionId: "s-1"
      }));
      expect(session.messages[0].content).toEqual([{ kind: "text", text: "done" }]);
      expect(events).toHaveLength(1);
      expect(events[0].messageId).toBe(session.messages[0].id);
      expect(session.saveCalls).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  it("emits usage.recorded after assistant.message.completed (phase4_B-1)", async () => {
    const session = await makeSession();
    try {
      const order = [];
      session.events.on("assistant.message.completed", () => order.push("completed"));
      session.events.on("usage.recorded", (event) => order.push(`usage:${event.inputTokens}/${event.outputTokens}`));

      await handleModelResponseWithoutTools({
        session,
        response: {
          message: { role: "assistant", content: "ok" },
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 4 }
        },
        needsFileMutation: false,
        turnStartIndex: 0,
        round: 7
      });

      expect(order).toEqual(["completed", "usage:10/4"]);
    } finally {
      await session.cleanup();
    }
  });

  it("emits usage.recorded after the assistant.message.completed of a tools round", async () => {
    const session = await makeSession({ executeSingleToolCallImpl: async () => ({ kind: "read_file", summary: "ok", data: {} }) });
    try {
      const order = [];
      session.events.on("assistant.message.completed", () => order.push("completed"));
      session.events.on("usage.recorded", () => order.push("usage"));
      session.events.on("tool.call.completed", () => order.push("tool"));

      await executeToolsRound({
        session,
        round: 1,
        toolCalls: [{ id: "call-1", name: "read_file", args: { filePath: "x" } }],
        response: { usage: { inputTokens: 1, outputTokens: 1 } }
      });

      expect(order[0]).toBe("completed");
      expect(order[1]).toBe("usage");
      expect(order.includes("tool")).toBe(true);
      expect(order.indexOf("usage")).toBeLessThan(order.indexOf("tool"));
    } finally {
      await session.cleanup();
    }
  });

  it("A+B: injects task-completion retry when session.procwayMeta is set and task complete wasn't called", async () => {
    const session = await makeSession();
    try {
      // A: simulate seed-from-worker-prompt — runTurn would normally do this
      session.procwayMeta = { project: "procway", ticket: "TK-139", task: "ui-design" };

      const promptEvents = [];
      session.events.on("user.prompt.submitted", (event) => promptEvents.push(event));

      const response = { message: { role: "assistant", content: "I think the task is done." }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const outcome = await handleModelResponseWithoutTools({
        session,
        response,
        needsFileMutation: false,
        // Per-call params left null: the session-level meta should drive it.
        turnStartIndex: 0,
        round: 5
      });

      expect(outcome).toEqual({ action: "continue" });
      expect(session.messages).toHaveLength(2);
      expect(session.messages[1].role).toBe("user");
      expect(session.messages[1].content[0].text).toContain("task complete procway TK-139 ui-design");
      expect(promptEvents).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  // Phase 4c hearing hand-off: interactive workers end turns without `task
  // complete` by design (awaiting-user-input → ChatPanel). The retry loop
  // must NOT fire, or the worker gets bullied into self-answering the
  // hearing and completing the task without ever asking the user.
  it("A+B: does NOT inject the retry for interactive (hearing) sessions", async () => {
    const session = await makeSession();
    try {
      session.procwayMeta = { project: "procway", ticket: "TK-139", task: "requirements-elicitation", interactive: true };

      const response = { message: { role: "assistant", content: "質問: 1) ゴールは? 2) スコープは?" }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const outcome = await handleModelResponseWithoutTools({
        session,
        response,
        needsFileMutation: false,
        turnStartIndex: 0,
        round: 1
      });

      // Turn ends cleanly — the question text is the hand-off to the user.
      expect(outcome.action).toBe("return");
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe("assistant");
    } finally {
      await session.cleanup();
    }
  });

  it("A+B: stops nagging once task complete tool result is in the message history", async () => {
    const session = await makeSession();
    try {
      session.procwayMeta = { project: "procway", ticket: "TK-139", task: "ui-design" };
      // simulate a prior successful `task complete` call
      session.messages.push({
        role: "tool",
        content: [{
          kind: "tool_result",
          ok: true,
          result: { data: { command: 'node x task complete procway TK-139 ui-design', exitCode: 0, stdout: '{"completed":true}', stderr: "" } }
        }]
      });

      const response = { message: { role: "assistant", content: "All done." }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const outcome = await handleModelResponseWithoutTools({
        session,
        response,
        needsFileMutation: false,
        turnStartIndex: 0,
        round: 5
      });

      // Should pass through to action: return, not loop with a retry prompt.
      expect(outcome.action).toBe("return");
    } finally {
      await session.cleanup();
    }
  });

  // Regression (2026-06-07 無限ループ): procwayMeta sticks on the session, so a
  // follow-up ChatPanel message AFTER the task completed starts a NEW turn whose
  // turnStartIndex is past the successful `task complete` record. The check used
  // to scan from turnStartIndex and re-demanded `task complete`, which the
  // server rejects with 400 ALREADY_COMPLETED — an unwinnable loop that only
  // ended at maxToolRounds. Completion evidence from ANY earlier turn must
  // satisfy the check.
  it("A+B: does NOT re-demand task complete on a follow-up turn after an earlier-turn completion", async () => {
    const session = await makeSession();
    try {
      session.procwayMeta = { project: "procway", ticket: "TK-139", task: "ui-design" };
      // Turn 1: worker completed the task.
      session.messages.push({
        role: "tool",
        content: [{
          kind: "tool_result",
          ok: true,
          result: { data: { command: 'node x task complete procway TK-139 ui-design', exitCode: 0, stdout: '{"completed":true}', stderr: "" } }
        }]
      });
      // Turn 2: user sends a follow-up chat message — turnStartIndex is AFTER
      // the completion record.
      session.messages.push({
        role: "user",
        content: [{ kind: "text", text: "ありがとう！変更点をまとめてもらえますか？" }]
      });
      const turnStartIndex = session.messages.length - 1;

      const response = { message: { role: "assistant", content: "変更点は次の通りです…" }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const outcome = await handleModelResponseWithoutTools({
        session,
        response,
        needsFileMutation: false,
        turnStartIndex,
        round: 0
      });

      expect(outcome.action).toBe("return");
      // No synthetic retry prompt appended after the assistant reply.
      expect(session.messages.at(-1).role).toBe("assistant");
    } finally {
      await session.cleanup();
    }
  });

  // Companion regression: the completion happened OUTSIDE the session (UI /
  // human CLI), so no exit-0 record exists anywhere in history. The worker's
  // own `task complete` attempt then fails with ALREADY_COMPLETED — that
  // server verdict must satisfy the check (matchesAlreadyCompletedBlock).
  it("A+B: ALREADY_COMPLETED rejection in this turn satisfies the completion check", async () => {
    const session = await makeSession();
    try {
      session.procwayMeta = { project: "procway", ticket: "TK-139", task: "ui-design" };
      session.messages.push({
        role: "user",
        content: [{ kind: "text", text: "続きをお願いします" }]
      });
      const turnStartIndex = session.messages.length - 1;
      session.messages.push({
        role: "tool",
        content: [{
          kind: "tool_result",
          ok: true,
          result: { data: { command: 'node x task complete procway TK-139 ui-design', exitCode: 1, stdout: "", stderr: 'Error (400 ALREADY_COMPLETED): Task "ui-design" is already completed' } }
        }]
      });

      const response = { message: { role: "assistant", content: "このタスクは既に完了済みです。" }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const outcome = await handleModelResponseWithoutTools({
        session,
        response,
        needsFileMutation: false,
        turnStartIndex,
        round: 1
      });

      expect(outcome.action).toBe("return");
      expect(session.messages.at(-1).role).toBe("assistant");
    } finally {
      await session.cleanup();
    }
  });

  it("B: raisePendingTaskCompletionIfNeeded sets the flag only when complete is missing", async () => {
    const session = await makeSession();
    try {
      // No procwayMeta → never raises
      session.raisePendingTaskCompletionIfNeeded();
      expect(session.pendingTaskCompletionReminder).toBe(false);

      // procwayMeta + no completion → raises
      session.procwayMeta = { project: "p", ticket: "TK-1", task: "t1" };
      session.raisePendingTaskCompletionIfNeeded();
      expect(session.pendingTaskCompletionReminder).toBe(true);

      // After successful task complete → no longer raises (reset first)
      session.pendingTaskCompletionReminder = false;
      session.messages.push({
        role: "tool",
        content: [{
          kind: "tool_result",
          ok: true,
          result: { data: { command: 'node x task complete p TK-1 t1', exitCode: 0, stdout: '{"completed":true}', stderr: "" } }
        }]
      });
      session.raisePendingTaskCompletionIfNeeded();
      expect(session.pendingTaskCompletionReminder).toBe(false);
    } finally {
      await session.cleanup();
    }
  });

  it("adds guard retry prompts when a requested file write was skipped", async () => {
    const session = await makeSession();
    try {
      const promptEvents = [];
      session.events.on("user.prompt.submitted", (event) => promptEvents.push(event));

      const response = { message: { role: "assistant", content: "I'll write it." }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };

      const outcome = await handleModelResponseWithoutTools({
        session,
        response,
        needsFileMutation: true,
        turnStartIndex: 0,
        round: 2
      });

      expect(outcome).toEqual({ action: "continue" });
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0].role).toBe("assistant");
      expect(session.messages[1].role).toBe("user");
      expect(session.messages[1].content[0].text).toContain("Call write_file, apply_patch, or Edit now");
      expect(promptEvents).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  it("fix 3: stops the file-mutation retry loop when the same tool keeps failing identically", async () => {
    const session = await makeSession();
    try {
      const pushWriteFailure = () => session.messages.push({
        role: "tool",
        content: [{
          kind: "tool_result",
          ok: false,
          result: { summary: "Error", data: { tool: "write_file", error: 'write_file requires "filePath" (string) but it was missing' } }
        }]
      });

      const response = { message: { role: "assistant", content: "I'll write it." }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const call = () => handleModelResponseWithoutTools({ session, response, needsFileMutation: true, turnStartIndex: 0, round: 3 });

      // Round A: a deterministic write_file failure this turn, then the model
      // ends without a successful write → first encounter injects the nudge.
      pushWriteFailure();
      expect((await call()).action).toBe("continue");
      // Round C: the model retried write_file after the nudge and it failed the
      // SAME way (a NEW failure recorded AFTER the injected retry prompt)...
      pushWriteFailure();
      // ...so the next text-only encounter aborts the loop.
      const stopped = await call();
      expect(stopped.action).toBe("stop");
      expect(stopped.response.error.code).toBe("file_mutation_retry_exhausted");
      expect(stopped.response.error.message).toContain("kept failing the same way");
    } finally {
      await session.cleanup();
    }
  });

  it("fix 3: does NOT abort on a stale/unrelated failure across consecutive text-only rounds", async () => {
    const session = await makeSession();
    try {
      // An unrelated, OLD failure (read_file — not a file-writing tool) recorded
      // once at the top of the turn. The model then never actually attempts a
      // write, ending two consecutive rounds with plain text. The stale-signature
      // bug re-detected this old failure each round and aborted after a single
      // nudge with a bogus reason ("read_file:..."). It must not: with no NEW
      // write failure since the nudge, the loop is bounded only by the count cap.
      session.messages.push({
        role: "tool",
        content: [{
          kind: "tool_result",
          ok: false,
          result: { summary: "Error", data: { tool: "read_file", error: "ENOENT: missing.txt" } }
        }]
      });

      const response = { message: { role: "assistant", content: "Let me think about the file." }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const call = () => handleModelResponseWithoutTools({ session, response, needsFileMutation: true, turnStartIndex: 0, round: 3 });

      // First three encounters keep nudging (no repeated write failure to bail on)...
      expect((await call()).action).toBe("continue");
      expect((await call()).action).toBe("continue");
      expect((await call()).action).toBe("continue");
      // ...and only the independent count cap ends it — never the same-failure path.
      const stopped = await call();
      expect(stopped.action).toBe("stop");
      expect(stopped.response.error.message).not.toContain("read_file");
      expect(stopped.response.error.message).toContain(`after ${3} attempts`);
    } finally {
      await session.cleanup();
    }
  });

  it("fix 3: caps the file-mutation retry loop at an independent low limit", async () => {
    const session = await makeSession();
    try {
      const response = { message: { role: "assistant", content: "I'll write it." }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const call = () => handleModelResponseWithoutTools({ session, response, needsFileMutation: true, turnStartIndex: 0, round: 3 });

      // No recorded tool failure → distinct (null) signatures, so the loop is
      // bounded by the count cap (3) rather than the repeat detector.
      expect((await call()).action).toBe("continue");
      expect((await call()).action).toBe("continue");
      expect((await call()).action).toBe("continue");
      const stopped = await call();
      expect(stopped.action).toBe("stop");
      expect(stopped.response.error.code).toBe("file_mutation_retry_exhausted");
    } finally {
      await session.cleanup();
    }
  });

  it("fix 3: a stop outcome ends runTurn normally — turn.failed emitted and runningTurn cleared", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-code-stop-"));
    try {
      const events = new EventBus();
      const failed = [];
      events.on("turn.failed", (e) => failed.push(e));
      const session = new AgentSession({
        settings: {
          defaultProvider: "scripted",
          defaultModel: "m",
          approvalMode: "auto",
          tools: { maxToolRounds: 150, maxParallelTools: 1 },
          providers: { scripted: { type: "openai-compatible" } },
          session: { enabled: false },
          agents: {}
        },
        cwd,
        sessionId: "s-stop",
        events
      });
      await session.initialize();

      // Scripted model: every round the model claims it will write a file but
      // emits a write_file call with NO filePath (truncated-args shape) — which
      // registry validation fails identically each round. The prompt requests a
      // file mutation, so the retry loop engages; the same-failure detector must
      // abort it and end the turn cleanly.
      let n = 0;
      const runProviderImpl = async () => {
        n += 1;
        // Alternate: tool-call round (fails), then a no-tools text round that
        // triggers handleModelResponseWithoutTools's retry decision.
        if (n % 2 === 1) {
          return { message: { role: "assistant" }, toolCalls: [{ id: `c${n}`, name: "write_file", args: { content: "x" } }], usage: {} };
        }
        return { message: { role: "assistant", content: "I'll create plan.md now." }, toolCalls: [], usage: {} };
      };

      const result = await session.runTurn("Please create plan.md with the outline.", { runProviderImpl });

      expect(result.error.code).toBe("file_mutation_retry_exhausted");
      expect(session.runningTurn).toBe(false);
      expect(failed).toHaveLength(1);
      expect(failed[0].error.code).toBe("file_mutation_retry_exhausted");
      // Bounded well below maxToolRounds (150).
      expect(n).toBeLessThan(12);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("emits turn.completed with the user.prompt.submitted messageId (phase6_E-4)", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-turn-msgid-"));
    try {
      const events = new EventBus();
      const userPromptIds = [];
      const turnCompletedEvents = [];
      events.on("user.prompt.submitted", (event) => userPromptIds.push(event.messageId));
      events.on("turn.completed", (event) => turnCompletedEvents.push(event));
      const session = await createAgentSession({
        settings: settingsForCliAgent(),
        cwd,
        sessionId: "msgid-1",
        events
      });
      await session.runTurn("hello messageId");
      await session.flushEventLog();
      expect(userPromptIds).toHaveLength(1);
      expect(turnCompletedEvents).toHaveLength(1);
      expect(turnCompletedEvents[0].messageId).toBe(userPromptIds[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("executes tool calls, emits structured ToolResult events, and appends a tool message", async () => {
    const toolResult = { kind: "read_file", summary: "Read 1 B from README.md", data: { path: "README.md", bytes: 1 } };
    const session = await makeSession({ executeSingleToolCallImpl: async () => toolResult });
    try {
      const completed = [];
      const startedEvents = [];
      const scheduledEvents = [];
      session.events.on("tool.call.completed", (event) => completed.push(event));
      session.events.on("tool.call.started", (event) => startedEvents.push(event));
      session.events.on("tool.call.scheduled", (event) => scheduledEvents.push(event));

      await executeToolsRound({
        session,
        round: 1,
        toolCalls: [{ id: "call-1", name: "read_file", args: { filePath: "README.md" } }]
      });

      expect(startedEvents).toHaveLength(1);
      expect(startedEvents[0]).toEqual(expect.objectContaining({
        type: "tool.call.started",
        toolCallId: "call-1",
        name: "read_file"
      }));

      expect(session.executeSingleToolCallCalls).toHaveLength(1);
      expect(session.executeSingleToolCallCalls[0]).toEqual({
        id: "call-1",
        name: "read_file",
        args: { filePath: "README.md" }
      });
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0].role).toBe("assistant");
      expect(session.messages[0].content[0]).toEqual(expect.objectContaining({
        kind: "tool_use",
        toolCallId: "call-1",
        name: "read_file"
      }));
      expect(session.messages[1].role).toBe("tool");
      expect(session.messages[1].toolCallId).toBe("call-1");
      expect(session.messages[1].content[0]).toEqual({
        kind: "tool_result",
        toolCallId: "call-1",
        ok: true,
        result: toolResult
      });
      expect(completed).toHaveLength(1);
      expect(completed[0].result).toBe(toolResult);
      expect(completed[0].ok).toBe(true);
      const scheduled = scheduledEvents.find((event) => event.toolCallId === "call-1");
      expect(scheduled).toEqual(expect.objectContaining({
        type: "tool.call.scheduled",
        name: "read_file",
        mutation: false
      }));
      expect(session.saveCalls).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });
});

/**
 * `toolCallBudgetMs` had NO test at all, which is how a tool that legitimately
 * blocks for minutes ends up silently back on the scheduler's shared 60s
 * timeout — a failure that never shows up in a unit run and kills a real run
 * loop / JOIN in production. Every branch is pinned here.
 *
 * Issue #143 Phase 2 (event-driven JOIN) makes this MORE load-bearing, not
 * less: the run tools still await, they just await an event instead of a poll.
 */
describe("toolCallBudgetMs (scheduler budget for tools that block)", () => {
  const GRACE = 30_000;
  const sessionWith = (tools = {}, agents = {}) => ({ settings: { tools, agents } });

  it("gives no budget (scheduler default) to ordinary tools", () => {
    expect(toolCallBudgetMs({ name: "read_file", args: { filePath: "a" } }, sessionWith())).toBeNull();
    expect(toolCallBudgetMs({ name: "agent_job", args: { action: "status" } }, sessionWith())).toBeNull();
    // A BACKGROUND run_shell returns immediately — nothing to budget for.
    expect(toolCallBudgetMs({ name: "run_shell", args: { command: "sleep 1", runInBackground: true } }, sessionWith())).toBeNull();
  });

  it("run_shell: mirrors the shell tool's own deadline plus the grace margin", () => {
    expect(toolCallBudgetMs({ name: "run_shell", args: { command: "ls" } }, sessionWith())).toBe(300_000 + GRACE);
    expect(toolCallBudgetMs({ name: "run_shell", args: { command: "ls", timeoutMs: 90_000 } }, sessionWith())).toBe(90_000 + GRACE);
    expect(toolCallBudgetMs({ name: "run_shell", args: { command: "ls" } }, sessionWith({ shellTimeoutMs: 120_000 }))).toBe(120_000 + GRACE);
  });

  it("run_shell: an orchestration drive gets the relaxed ceiling, never below any configured timer", () => {
    const cmd = 'node "$PROCWAY_CLI" run loop --project p';
    expect(toolCallBudgetMs({ name: "run_shell", args: { command: cmd } }, sessionWith()))
      .toBe(DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS + GRACE);
    // The budget must never be LOWER than the shell's own timer, whichever of
    // the three sources is highest (shell.mjs takes the same max).
    const huge = DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS * 2;
    expect(toolCallBudgetMs({ name: "run_shell", args: { command: cmd, timeoutMs: huge } }, sessionWith())).toBe(huge + GRACE);
    expect(toolCallBudgetMs({ name: "run_shell", args: { command: cmd } }, sessionWith({ sandbox: { timeoutMs: huge } }))).toBe(huge + GRACE);
  });

  it("shell_job / agent_job wait: the tool owns its deadline, the scheduler waits one margin longer", () => {
    for (const name of ["shell_job", "agent_job"]) {
      expect(toolCallBudgetMs({ name, args: { action: "wait" } }, sessionWith()), name).toBe(600_000 + GRACE);
      expect(toolCallBudgetMs({ name, args: { action: "wait", waitMs: 90_000 } }, sessionWith()), name).toBe(90_000 + GRACE);
    }
  });

  it("spawn_agent: the child's own provider deadline, floored at the long-running ceiling", () => {
    expect(toolCallBudgetMs({ name: "spawn_agent", args: {} }, sessionWith()))
      .toBe(DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS + GRACE);
    // A child deadline BELOW the ceiling must not shrink the budget...
    expect(toolCallBudgetMs({ name: "spawn_agent", args: {} }, sessionWith({}, { defaultTimeoutMs: 5_000 })))
      .toBe(DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS + GRACE);
    // ...and one above it must raise it.
    const above = DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS + 60_000;
    expect(toolCallBudgetMs({ name: "spawn_agent", args: {} }, sessionWith({}, { defaultTimeoutMs: above })))
      .toBe(above + GRACE);
  });

  it("the four run tools get the long-running budget — and it OUTLASTS their own wait", () => {
    // Deleting this branch would put a JOIN back on the shared 60s tool timeout.
    for (const name of ["start_run", "attach_run", "resume_run", "reply_run"]) {
      expect(toolCallBudgetMs({ name, args: {} }, sessionWith()), name)
        .toBe(DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS + GRACE);

      const lr = 30 * 60_000;
      const budget = toolCallBudgetMs({ name, args: {} }, sessionWith({ longRunningShellTimeoutMs: lr }));
      expect(budget, name).toBe(lr + GRACE);
      // The ordering that matters: the tool's own deadline fires FIRST, so it
      // returns its honest "still running" yield instead of being SIGTERMed.
      expect(joinTimeoutMsFor(lr), name).toBeLessThan(budget);
    }
  });
});

/**
 * The other half of the turn-idle watchdog chain (issue #143 Phase 2): a tool
 * that reports progress must produce `activity.tick` session events, because
 * ANY session event is what bumps the watchdog. The JOIN's heartbeat travels
 * this path; if it stops, a long JOIN is aborted at 180s.
 */
describe("onProgress → activity.tick (turn-idle watchdog food)", () => {
  it("emits one activity.tick per progress report of a long-blocking tool", async () => {
    const session = await makeSession();
    try {
      const ticks = [];
      session.events.on("activity.tick", (event) => ticks.push(event));
      // Stand in for attach_run: block, reporting progress as it waits.
      session.executeSingleToolCall = async (toolCall, { onProgress } = {}) => {
        for (let i = 1; i <= 3; i += 1) onProgress({ detail: `run r1: running — waiting for it to settle (${i * 20}s)` });
        onProgress({ detail: "run r1: completed" });
        return { kind: "attach_run", summary: "Run r1 completed", data: { jobId: "r1", status: "completed" } };
      };

      await executeToolsRound({
        session,
        round: 1,
        toolCalls: [{ id: "call-join", name: "attach_run", args: { runId: "r1" } }],
        response: { usage: { inputTokens: 1, outputTokens: 1 } }
      });

      expect(ticks).toHaveLength(4);
      expect(ticks[0].detail).toContain("run r1");
      expect(ticks.at(-1).detail).toBe("run r1: completed");
      expect(ticks.every((t) => typeof t.elapsedMs === "number")).toBe(true);
    } finally {
      await session.cleanup();
    }
  });
});
