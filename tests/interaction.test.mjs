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

describe("InteractionCoordinator", () => {
  it("emits interaction.requested and resolves on resolveInteraction with arbitrary JSON", async () => {
    const events = new EventBus();
    const coordinator = new InteractionCoordinator({ events, timeoutMs: 0 });
    const requested = [];
    const resolved = [];
    events.on("interaction.requested", (e) => requested.push(e));
    events.on("interaction.resolved", (e) => resolved.push(e));

    const p = coordinator.request({ kind: "env_vars", summary: "set FOO", spec: { keys: [{ key: "FOO" }] } });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toEqual(expect.objectContaining({ kind: "env_vars", summary: "set FOO" }));
    expect(requested[0].spec).toEqual({ keys: [{ key: "FOO" }] });
    const requestId = requested[0].requestId;
    expect(coordinator.has(requestId)).toBe(true);
    expect(coordinator.hasPending()).toBe(true);

    coordinator.resolveInteraction(requestId, { committed: true, keys: ["FOO"] });
    await expect(p).resolves.toEqual({ committed: true, keys: ["FOO"] });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual(expect.objectContaining({ requestId, response: { committed: true, keys: ["FOO"] } }));
    expect(coordinator.has(requestId)).toBe(false);
    expect(coordinator.hasPending()).toBe(false);
  });

  it("returns false for an unknown requestId", () => {
    const coordinator = new InteractionCoordinator({ events: new EventBus(), timeoutMs: 0 });
    expect(coordinator.resolveInteraction("nope", {})).toBe(false);
  });

  it("non-blocking request resolves immediately and stays unpending", async () => {
    const events = new EventBus();
    const requested = [];
    events.on("interaction.requested", (e) => requested.push(e));
    const coordinator = new InteractionCoordinator({ events, timeoutMs: 0 });
    const out = await coordinator.request({ kind: "env_vars", blocking: false });
    expect(out).toEqual(expect.objectContaining({ blocking: false }));
    expect(requested).toHaveLength(1);
    expect(coordinator.hasPending()).toBe(false);
  });

  it("fallback timeout resolves with { timedOut: true } and clears pending", async () => {
    const events = new EventBus();
    const resolved = [];
    events.on("interaction.resolved", (e) => resolved.push(e));
    const coordinator = new InteractionCoordinator({ events, timeoutMs: 20 });
    const response = await coordinator.request({ kind: "env_vars", summary: "s" });
    expect(response).toEqual({ timedOut: true });
    expect(coordinator.hasPending()).toBe(false);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].response).toEqual({ timedOut: true });
  });

  it("does not consult permissions/approvalMode (constructed with only an events bus)", async () => {
    // No settings / permissions passed — a gate would have thrown or denied.
    const coordinator = new InteractionCoordinator({ events: new EventBus(), timeoutMs: 0 });
    const p = coordinator.request({ kind: "env_vars" });
    const id = [...coordinator.pending.keys()][0];
    coordinator.resolveInteraction(id, { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
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

describe("AgentSession interaction roundtrip", () => {
  it("session.resolveInteraction resolves a coordinator request", async () => {
    const { AgentSession } = await import("../src/agent/conversation.mjs");
    const session = new AgentSession({
      settings: { session: { enabled: false }, agents: {}, tools: {} },
      sessionId: "interaction-rt",
      cwd: process.cwd()
    });
    await session.initialize();
    const requested = [];
    session.events.on("interaction.requested", (e) => {
      requested.push(e);
      setImmediate(() => session.resolveInteraction(e.requestId, { committed: true }));
    });
    const response = await session.interactionCoordinator.request({ kind: "env_vars", summary: "s", sessionId: session.sessionId });
    expect(response).toEqual({ committed: true });
    expect(requested).toHaveLength(1);
    expect(requested[0].sessionId).toBe("interaction-rt");
  });
});
