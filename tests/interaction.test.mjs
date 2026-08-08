import { describe, expect, it } from "vitest";
import { InteractionCoordinator } from "../src/runtime/interaction.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent, isKnownEventType } from "../src/core/events/types.mjs";
import { isKnownToolKind, isToolResult } from "../src/core/types/tool-result.mjs";
import { getToolDefinitions, executeToolCall, isMutationTool } from "../src/tools/registry.mjs";

describe("interaction event + tool-result registration", () => {
  it("registers interaction.requested / interaction.resolved as known events", () => {
    expect(isKnownEventType("interaction.requested")).toBe(true);
    expect(isKnownEventType("interaction.resolved")).toBe(true);
    // createEvent must not throw for the new types.
    expect(createEvent("interaction.requested", { requestId: "r1", kind: "env_vars", summary: "s" }).type).toBe("interaction.requested");
    expect(createEvent("interaction.resolved", { requestId: "r1", response: { ok: true } }).type).toBe("interaction.resolved");
  });

  it("registers the 'interaction' tool-result kind", () => {
    expect(isKnownToolKind("interaction")).toBe(true);
    expect(isToolResult({ kind: "interaction", summary: "x", data: {} })).toBe(true);
  });
});

describe("InteractionCoordinator (ADR 0037 D1 — terminal, record-and-broadcast)", () => {
  it("request() emits interaction.requested and returns immediately (never blocks)", async () => {
    const events = new EventBus();
    const coordinator = new InteractionCoordinator({ events });
    const requested = [];
    events.on("interaction.requested", (e) => requested.push(e));

    const out = await coordinator.request({ kind: "env_vars", summary: "set FOO", spec: { keys: [{ key: "FOO" }] } });
    expect(out).toEqual({ requestId: expect.any(String), blocking: false });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toEqual(expect.objectContaining({ kind: "env_vars", summary: "set FOO", blocking: false }));
    expect(requested[0].spec).toEqual({ keys: [{ key: "FOO" }] });
    expect(requested[0].requestId).toBe(out.requestId);
  });

  it("a blocking:true request is also terminal (the flag is ignored)", async () => {
    const events = new EventBus();
    const requested = [];
    events.on("interaction.requested", (e) => requested.push(e));
    const coordinator = new InteractionCoordinator({ events });
    const out = await coordinator.request({ kind: "approval", blocking: true });
    expect(out.blocking).toBe(false);
    expect(requested[0].blocking).toBe(false);
  });

  it("resolveInteraction broadcasts interaction.resolved and returns true", () => {
    const events = new EventBus();
    const resolved = [];
    events.on("interaction.resolved", (e) => resolved.push(e));
    const coordinator = new InteractionCoordinator({ events });
    expect(coordinator.resolveInteraction("req-1", { committed: true }, { sessionId: "s-1" })).toBe(true);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual(expect.objectContaining({ requestId: "req-1", response: { committed: true }, sessionId: "s-1" }));
  });

  it("resolveInteraction rejects a missing requestId", () => {
    const coordinator = new InteractionCoordinator({ events: new EventBus() });
    expect(coordinator.resolveInteraction("", {})).toBe(false);
    expect(coordinator.resolveInteraction(undefined, {})).toBe(false);
  });

  it("does not consult permissions/approvalMode (constructed with only an events bus)", async () => {
    // No settings / permissions passed — a gate would have thrown or denied.
    const coordinator = new InteractionCoordinator({ events: new EventBus() });
    const out = await coordinator.request({ kind: "env_vars" });
    expect(typeof out.requestId).toBe("string");
  });
});

describe("request_user_action tool", () => {
  it("is registered and classified read-only (not a mutation)", () => {
    const def = getToolDefinitions().find((d) => d.function?.name === "request_user_action");
    expect(def).toBeTruthy();
    expect(def.function.parameters.required).toEqual(["kind"]);
    expect(isMutationTool("request_user_action")).toBe(false);
  });

  it("dispatches through interactionRequester and wraps the response", async () => {
    const calls = [];
    const result = await executeToolCall({
      name: "request_user_action",
      args: { kind: "env_vars", summary: "set FOO", spec: { keys: [{ key: "FOO" }] } },
      cwd: process.cwd(),
      settings: {},
      interactionRequester: async (req) => { calls.push(req); return { committed: true, keys: ["FOO"] }; }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({ kind: "env_vars", blocking: true }));
    expect(result.kind).toBe("interaction");
    expect(result.data).toEqual({ kind: "env_vars", blocking: true, response: { committed: true, keys: ["FOO"] } });
  });

  it("returns a skipped result when no interaction requester is wired", async () => {
    const result = await executeToolCall({
      name: "request_user_action",
      args: { kind: "env_vars" },
      cwd: process.cwd(),
      settings: {},
      interactionRequester: null
    });
    expect(result.kind).toBe("interaction");
    expect(result.data).toEqual(expect.objectContaining({ skipped: true, reason: "no-interaction-requester" }));
  });
});

describe("AgentSession universal UIR deferral (ADR 0037 D1 Phase 2)", () => {
  const baseSettings = { session: { enabled: false }, agents: {}, tools: {} };

  async function makeSession(overrides = {}) {
    const { AgentSession } = await import("../src/agent/conversation.mjs");
    const session = new AgentSession({
      settings: baseSettings,
      sessionId: "uir-defer",
      cwd: process.cwd(),
      interactive: true,
      ...overrides
    });
    await session.initialize();
    return session;
  }

  for (const kind of ["survey", "env_vars", "approval"]) {
    it(`defers ${kind}: stamps pausedForInput and returns a deferred marker`, async () => {
      const session = await makeSession();
      const requested = [];
      session.events.on("interaction.requested", (e) => requested.push(e));

      const out = await session.requestUserInteraction({ kind, summary: "s", spec: { x: 1 } });

      expect(out).toEqual(expect.objectContaining({ blocking: false, deferred: true }));
      expect(typeof out.requestId).toBe("string");
      // The turn wind-down reads this off the session.
      expect(session.pausedForInput).toEqual(expect.objectContaining({ kind, summary: "s", spec: { x: 1 } }));
      // The request was recorded (emitted) — nothing waits in-process; the
      // surface answers asynchronously and the answer arrives as a NEW turn.
      expect(requested).toHaveLength(1);
      expect(requested[0]).toEqual(expect.objectContaining({ kind, blocking: false }));
    });
  }

  it("an explicit blocking:false request stays a fire-and-forget nudge (no wind-down)", async () => {
    const session = await makeSession();
    const out = await session.requestUserInteraction({ kind: "survey", summary: "fyi", blocking: false });
    expect(out).toEqual(expect.objectContaining({ blocking: false }));
    expect(out.deferred).toBeUndefined();
    expect(session.pausedForInput).toBeNull();
  });

  it("hearingReturnMode defers every kind (unchanged §6 behavior)", async () => {
    const session = await makeSession({ hearingReturnMode: true });
    const out = await session.requestUserInteraction({ kind: "approval", summary: "s" });
    expect(out).toEqual(expect.objectContaining({ blocking: false, deferred: true }));
    expect(session.pausedForInput).toEqual(expect.objectContaining({ kind: "approval" }));
  });

  it("runTurn clears a stale pausedForInput at the start of a fresh turn", async () => {
    const session = await makeSession();
    session.pausedForInput = { requestId: "old", kind: "survey" };
    // runTurn throws early (no provider wired) but must clear pausedForInput
    // before that so a reused live session's resume turn starts clean.
    await session.runTurn("hello").catch(() => {});
    expect(session.pausedForInput).toBeNull();
  });
});

describe("AgentSession interaction resolve broadcast", () => {
  it("session.resolveInteraction re-emits interaction.resolved (pure broadcast)", async () => {
    const { AgentSession } = await import("../src/agent/conversation.mjs");
    const session = new AgentSession({
      settings: { session: { enabled: false }, agents: {}, tools: {} },
      sessionId: "interaction-rt",
      cwd: process.cwd()
    });
    await session.initialize();
    const resolved = [];
    session.events.on("interaction.resolved", (e) => resolved.push(e));
    expect(session.resolveInteraction("req-9", { committed: true })).toBe(true);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual(expect.objectContaining({
      requestId: "req-9",
      response: { committed: true },
      sessionId: "interaction-rt"
    }));
  });
});
