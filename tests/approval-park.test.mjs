// ADR 0037 D1 (Phase 2) — tool-approval checkpoint/park + resume.
//
// A mid-turn "ask" verdict no longer blocks an in-memory Promise: the parking
// requester checkpoints a parked entry (snapshot-persisted), the tool settles
// as a "parked" placeholder tool_result, and the turn FOLDS (turn.completed).
// The user's decision — possibly after a reload / deploy / Pod restart —
// re-drives the tool for real, replaces the placeholder IN PLACE, and
// continues the remaining rounds so the user sees one continuous turn.
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { readSnapshot } from "../src/session/snapshot.mjs";

async function makeSession({ sessionId, persist = false, approvalMode = "always-ask", maxParallelTools = 1 } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-park-"));
  const session = new AgentSession({
    settings: {
      approvalMode,
      tools: { maxParallelTools, maxToolRounds: 6 },
      session: { enabled: persist },
      agents: {}
    },
    cwd,
    sessionId,
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

const writeCall = (id, file, content = "hello") => ({
  id,
  name: "write_file",
  args: { filePath: file, content }
});

async function waitFor(cond, { timeoutMs = 8000, intervalMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function findToolMessage(session, toolCallId) {
  return session.messages.find((m) => m.role === "tool"
    && Array.isArray(m.content)
    && m.content.some((b) => b?.kind === "tool_result" && (b.toolCallId ?? m.toolCallId) === toolCallId));
}

function parkedBlock(message) {
  return message?.content?.find((b) => b?.kind === "tool_result" && b.result?.data?.parked === true) ?? null;
}

describe("tool approval checkpoint/park (ADR 0037 D1)", () => {
  it("an 'ask' verdict mid-turn parks the tool, settles a placeholder result, and folds the turn", async () => {
    const session = await makeSession({ sessionId: "park-fold" });
    try {
      const requested = [];
      const completed = [];
      session.events.on("approval.requested", (e) => requested.push(e));
      session.events.on("turn.completed", (e) => completed.push(e));
      const provider = scriptedProvider([toolRound([writeCall("tc-1", "note.txt")])]);

      const result = await session.runTurn("write note.txt", { runProviderImpl: provider.impl });

      // The turn folded on the parked approval — surfaced to the caller too.
      expect(result).toEqual({ paused: true, pausedForApproval: [requested[0].requestId] });
      expect(completed).toHaveLength(1);
      expect(session.runningTurn).toBe(false);

      // The checkpoint: a parked entry the bridge can replay a card from.
      expect(requested).toHaveLength(1);
      expect(requested[0]).toEqual(expect.objectContaining({ kind: "write_file", summary: "note.txt" }));
      expect(session.listParkedApprovals()).toEqual([
        expect.objectContaining({ requestId: requested[0].requestId, kind: "write_file", sessionId: "park-fold" })
      ]);

      // The transcript carries a parked placeholder paired with the tool_use —
      // NOT a real result, and the tool did NOT run.
      const toolMessage = findToolMessage(session, "tc-1");
      const block = parkedBlock(toolMessage);
      expect(block).not.toBeNull();
      expect(block.result.data.approvalRequestId).toBe(requested[0].requestId);
      await expect(readFile(path.join(session.cwd, "note.txt"), "utf8")).rejects.toThrow();

      // The model was called exactly once — the fold happens WITHOUT another round.
      expect(provider.calls).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  it("allow re-drives the tool, replaces the placeholder in place, and continues the rounds as one turn", async () => {
    const session = await makeSession({ sessionId: "park-allow" });
    try {
      const requested = [];
      const resolved = [];
      const completed = [];
      session.events.on("approval.requested", (e) => requested.push(e));
      session.events.on("approval.resolved", (e) => resolved.push(e));
      session.events.on("turn.completed", (e) => completed.push(e));
      const provider = scriptedProvider([
        toolRound([writeCall("tc-1", "note.txt", "approved content")]),
        finalRound("done: note.txt written")
      ]);

      await session.runTurn("write note.txt", { runProviderImpl: provider.impl });
      const requestId = requested[0].requestId;

      // Resolve through the session's public approve() entry (what the serve
      // bridge `approve` command calls).
      expect(session.approve(requestId, "allow")).toBe(true);
      expect(resolved).toEqual([expect.objectContaining({ requestId, decision: "allow" })]);

      await waitFor(async () => provider.calls.length >= 2 && session.runningTurn === false, { label: "continuation ran" });

      // The tool actually executed on resume.
      await expect(readFile(path.join(session.cwd, "note.txt"), "utf8")).resolves.toBe("approved content");

      // In-place replacement: same tool message slot, real result, no parked
      // marker, and NO second tool message for tc-1 (provider-invalid).
      const toolMessages = session.messages.filter((m) => m.role === "tool" && (m.toolCallId === "tc-1"
        || m.content?.some?.((b) => b?.toolCallId === "tc-1")));
      expect(toolMessages).toHaveLength(1);
      expect(parkedBlock(toolMessages[0])).toBeNull();

      // The continuation round saw the REAL tool result in the transcript it
      // was driven with (one continuous turn from the model's perspective).
      const continuationMessages = provider.calls[1].messages ?? session.messages;
      expect(JSON.stringify(continuationMessages)).toContain("approved content");
      expect(JSON.stringify(continuationMessages)).not.toContain('"parked":true');

      // Fold + continuation each completed the turn cleanly.
      expect(completed).toHaveLength(2);
      const finalAssistant = session.messages.at(-1);
      expect(JSON.stringify(finalAssistant.content)).toContain("done: note.txt written");
      expect(session.parkedApprovals.size).toBe(0);
    } finally {
      await session.cleanup();
    }
  });

  it("deny settles the standard skipped result and still continues the turn", async () => {
    const session = await makeSession({ sessionId: "park-deny" });
    try {
      const requested = [];
      session.events.on("approval.requested", (e) => requested.push(e));
      const provider = scriptedProvider([
        toolRound([writeCall("tc-1", "note.txt")]),
        finalRound("ok, skipping the write")
      ]);
      await session.runTurn("write note.txt", { runProviderImpl: provider.impl });

      expect(session.approve(requested[0].requestId, "deny")).toBe(true);
      await waitFor(async () => provider.calls.length >= 2 && session.runningTurn === false, { label: "deny continuation" });

      await expect(readFile(path.join(session.cwd, "note.txt"), "utf8")).rejects.toThrow();
      const toolMessage = findToolMessage(session, "tc-1");
      const block = toolMessage.content.find((b) => b?.kind === "tool_result");
      expect(block.result.data).toEqual(expect.objectContaining({ skipped: true, error: "User denied approval" }));
      expect(parkedBlock(toolMessage)).toBeNull();
    } finally {
      await session.cleanup();
    }
  });

  it("always-allow records the kind so the next call of the same kind does not park", async () => {
    const session = await makeSession({ sessionId: "park-always" });
    try {
      const requested = [];
      session.events.on("approval.requested", (e) => requested.push(e));
      const provider = scriptedProvider([
        toolRound([writeCall("tc-1", "a.txt", "one")]),
        finalRound("first done")
      ]);
      await session.runTurn("write a.txt", { runProviderImpl: provider.impl });
      session.approve(requested[0].requestId, "always-allow");
      await waitFor(async () => provider.calls.length >= 2 && session.runningTurn === false, { label: "always-allow continuation" });
      expect(session.approvalCoordinator.alwaysAllow.has("write_file")).toBe(true);

      // Second turn: same kind auto-allows — no park, no card, tool runs inline.
      const provider2 = scriptedProvider([
        toolRound([writeCall("tc-2", "b.txt", "two")]),
        finalRound("second done")
      ]);
      const result2 = await session.runTurn("write b.txt", { runProviderImpl: provider2.impl });
      expect(result2.paused).toBeUndefined();
      expect(requested).toHaveLength(1);
      await expect(readFile(path.join(session.cwd, "b.txt"), "utf8")).resolves.toBe("two");
    } finally {
      await session.cleanup();
    }
  });

  it("multiple parks in one round stay folded until the LAST decision, then continue once", async () => {
    const session = await makeSession({ sessionId: "park-multi", maxParallelTools: 2 });
    try {
      const requested = [];
      session.events.on("approval.requested", (e) => requested.push(e));
      const provider = scriptedProvider([
        toolRound([writeCall("tc-1", "one.txt", "1"), writeCall("tc-2", "two.txt", "2")]),
        finalRound("both handled")
      ]);
      const result = await session.runTurn("write both", { runProviderImpl: provider.impl });
      expect(requested).toHaveLength(2);
      expect(result.pausedForApproval).toHaveLength(2);

      const byFile = new Map(requested.map((r) => [r.summary, r.requestId]));
      expect(session.approve(byFile.get("one.txt"), "allow")).toBe(true);
      await waitFor(async () => {
        try { await readFile(path.join(session.cwd, "one.txt"), "utf8"); return true; } catch { return false; }
      }, { label: "first tool re-driven" });
      // Still one park open — the turn must NOT have continued yet.
      expect(provider.calls).toHaveLength(1);
      expect(session.parkedApprovals.size).toBe(1);

      expect(session.approve(byFile.get("two.txt"), "allow")).toBe(true);
      await waitFor(async () => provider.calls.length >= 2 && session.runningTurn === false, { label: "final continuation" });
      await expect(readFile(path.join(session.cwd, "two.txt"), "utf8")).resolves.toBe("2");
      expect(session.parkedApprovals.size).toBe(0);
    } finally {
      await session.cleanup();
    }
  });

  it("unknown requestIds and decisions during a running turn are rejected without losing the checkpoint", async () => {
    const session = await makeSession({ sessionId: "park-guard" });
    try {
      const requested = [];
      session.events.on("approval.requested", (e) => requested.push(e));
      const provider = scriptedProvider([toolRound([writeCall("tc-1", "x.txt")])]);
      await session.runTurn("write x.txt", { runProviderImpl: provider.impl });
      const requestId = requested[0].requestId;

      expect(session.approve("nonexistent", "allow")).toBe(false);

      // While a turn is running the continuation cannot interleave — the
      // decision is refused and the parked entry SURVIVES for a retry.
      session.runningTurn = true;
      expect(session.approve(requestId, "allow")).toBe(false);
      expect(session.parkedApprovals.has(requestId)).toBe(true);
      session.runningTurn = false;
    } finally {
      await session.cleanup();
    }
  });

  it("park survives a session snapshot round-trip: a fresh session restores the checkpoint and resumes on approve (cold resume)", async () => {
    const sessionId = `park-cold-${Date.now()}`;
    const sessionA = await makeSession({ sessionId, persist: true });
    const requested = [];
    sessionA.events.on("approval.requested", (e) => requested.push(e));
    const providerA = scriptedProvider([toolRound([writeCall("tc-1", "cold.txt", "restored write")])]);
    await sessionA.runTurn("write cold.txt", { runProviderImpl: providerA.impl });
    const requestId = requested[0].requestId;

    // The fold force-saved the snapshot — the checkpoint is on disk.
    const snapshot = await readSnapshot({ sessionId });
    expect(snapshot.parkedApprovals).toEqual([
      expect.objectContaining({ requestId, kind: "write_file", summary: "cold.txt" })
    ]);

    // "Pod restart": a brand-new AgentSession (fresh EventBus, fresh memory)
    // on the same sessionId + cwd restores the parked entry from the snapshot.
    const sessionB = new AgentSession({
      settings: { approvalMode: "always-ask", tools: { maxParallelTools: 1, maxToolRounds: 6 }, session: { enabled: true }, agents: {} },
      cwd: sessionA.cwd,
      sessionId,
      events: new EventBus()
    });
    await sessionB.initialize();
    expect(sessionB.listParkedApprovals()).toEqual([
      expect.objectContaining({ requestId, kind: "write_file" })
    ]);
    // The placeholder came back with the transcript too.
    expect(parkedBlock(findToolMessage(sessionB, "tc-1"))).not.toBeNull();

    // Continuation provider for the restored session (production leaves this
    // null and talks to the real configured provider).
    const providerB = scriptedProvider([finalRound("resumed after restart")]);
    sessionB.turnRunProviderImpl = providerB.impl;

    expect(sessionB.approve(requestId, "allow")).toBe(true);
    await waitFor(async () => providerB.calls.length >= 1 && sessionB.runningTurn === false, { label: "cold-resume continuation" });

    await expect(readFile(path.join(sessionA.cwd, "cold.txt"), "utf8")).resolves.toBe("restored write");
    expect(parkedBlock(findToolMessage(sessionB, "tc-1"))).toBeNull();
    expect(JSON.stringify(sessionB.messages.at(-1).content)).toContain("resumed after restart");
    expect(sessionB.parkedApprovals.size).toBe(0);

    await sessionA.cleanup();
  });
});
