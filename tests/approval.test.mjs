import { describe, expect, it } from "vitest";
import { ApprovalCoordinator, requestApproval } from "../src/safety/approval.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { validateSettings } from "../src/config/schema.mjs";

describe("requestApproval (Phase 4)", () => {
  it("auto-approves under full-auto mode", async () => {
    await expect(requestApproval({
      kind: "write_file",
      summary: "x",
      mutation: true,
      approvalMode: "full-auto"
    })).resolves.toBe(true);
  });

  it("auto-denies under always-ask without a coordinator", async () => {
    await expect(requestApproval({
      kind: "write_file",
      summary: "x",
      mutation: true,
      approvalMode: "always-ask"
    })).resolves.toBe(false);
  });

  it("uses permissions to decide auto-readonly mutations", async () => {
    const permissions = { allow: ["write_file:safe.txt"] };
    await expect(requestApproval({
      kind: "write_file",
      summary: "safe.txt",
      mutation: true,
      approvalMode: "auto-readonly",
      permissions
    })).resolves.toBe(true);
    await expect(requestApproval({
      kind: "write_file",
      summary: "danger.txt",
      mutation: true,
      approvalMode: "auto-readonly",
      permissions
    })).resolves.toBe(false);
  });

  it("validates full-auto approval mode", () => {
    expect(validateSettings({ approvalMode: "full-auto" })).toEqual([]);
  });

  it("flags invalid permissions shape", () => {
    expect(validateSettings({ permissions: "nope" })).toContain("permissions must be an object with allow/deny/ask arrays");
    expect(validateSettings({ permissions: { allow: [1] } })).toContain("permissions.allow must be an array of strings");
  });
});

describe("ApprovalCoordinator", () => {
  it("emits approval.requested and resolves on session.approve", async () => {
    const events = new EventBus();
    const coordinator = new ApprovalCoordinator({ events, settings: {} });
    const requested = [];
    events.on("approval.requested", (event) => requested.push(event));
    const resolved = [];
    events.on("approval.resolved", (event) => resolved.push(event));

    const decisionPromise = coordinator.request({
      kind: "write_file",
      summary: "x.txt",
      mutation: true,
      approvalMode: "always-ask"
    });

    expect(requested).toHaveLength(1);
    expect(requested[0]).toEqual(expect.objectContaining({ kind: "write_file", summary: "x.txt" }));
    const requestId = requested[0].requestId;
    expect(coordinator.has(requestId)).toBe(true);

    coordinator.resolve(requestId, "allow");

    await expect(decisionPromise).resolves.toBe("allow");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual(expect.objectContaining({ requestId, decision: "allow" }));
    expect(coordinator.has(requestId)).toBe(false);
  });

  it("auto-decides via permissions before emitting events", async () => {
    const events = new EventBus();
    const requested = [];
    events.on("approval.requested", (event) => requested.push(event));
    const coordinator = new ApprovalCoordinator({
      events,
      settings: {
        permissions: {
          allow: ["read_file:*"],
          deny: ["write_file:secret*"]
        }
      }
    });

    await expect(coordinator.request({
      kind: "read_file",
      summary: "any",
      approvalMode: "auto-readonly"
    })).resolves.toBe("allow");

    await expect(coordinator.request({
      kind: "write_file",
      summary: "secret.env",
      mutation: true,
      approvalMode: "auto-readonly"
    })).resolves.toBe("deny");

    expect(requested).toHaveLength(0);
  });

  it("remembers always-allow decisions for the rest of the session", async () => {
    const events = new EventBus();
    const coordinator = new ApprovalCoordinator({ events, settings: {} });

    const first = coordinator.request({
      kind: "write_file",
      summary: "x.txt",
      mutation: true,
      approvalMode: "always-ask"
    });
    const requested = [];
    events.on("approval.requested", (event) => requested.push(event));

    const initialReq = [...coordinator.pending.keys()][0];
    coordinator.resolve(initialReq, "always-allow");
    await expect(first).resolves.toBe("always-allow");

    await expect(coordinator.request({
      kind: "write_file",
      summary: "y.txt",
      mutation: true,
      approvalMode: "always-ask"
    })).resolves.toBe("allow");
    expect(requested).toHaveLength(0);
  });

  it("approval prompt 'e' flow rewrites payload via launchEditor and resolves allow", async () => {
    const { attachApprovalPrompt } = await import("../src/adapters/tui/approval-prompt.mjs");
    const { AgentSession } = await import("../src/agent/conversation.mjs");
    const session = new AgentSession({
      settings: { approvalMode: "always-ask", session: { enabled: false }, agents: {}, tools: {} },
      sessionId: "approval-edit",
      cwd: process.cwd()
    });
    await session.initialize();

    const writes = [];
    const fakeOutput = { write(value) { writes.push(value); return true; } };
    const launchEditor = async ({ initial }) => `${initial}\n[edited by reviewer]`;
    const handler = attachApprovalPrompt({
      session,
      input: { isTTY: false },
      output: fakeOutput,
      launchEditor,
      prompt: async () => "e"
    });

    const editable = { content: "first draft\n", filePath: "src/notes.txt", before: null, after: "first draft\n", operation: "create" };
    const allowed = await session.approvalRequester({
      kind: "write_file",
      summary: "src/notes.txt",
      mutation: true,
      approvalMode: "always-ask",
      payload: editable
    });

    expect(allowed).toBe(true);
    expect(editable.content).toBe("first draft\n\n[edited by reviewer]");
    handler.dispose();
  });

  it("approval prompt 'e' flow with editor cancellation falls back to deny", async () => {
    const { attachApprovalPrompt } = await import("../src/adapters/tui/approval-prompt.mjs");
    const { AgentSession } = await import("../src/agent/conversation.mjs");
    const session = new AgentSession({
      settings: { approvalMode: "always-ask", session: { enabled: false }, agents: {}, tools: {} },
      sessionId: "approval-edit-cancel",
      cwd: process.cwd()
    });
    await session.initialize();
    const fakeOutput = { write() {} };
    const launchEditor = async () => null;
    const handler = attachApprovalPrompt({
      session,
      input: { isTTY: false },
      output: fakeOutput,
      launchEditor,
      prompt: async () => "e"
    });

    const editable = { content: "draft", filePath: "src/x.txt", before: null, after: "draft", operation: "create" };
    const allowed = await session.approvalRequester({
      kind: "write_file",
      summary: "src/x.txt",
      mutation: true,
      approvalMode: "always-ask",
      payload: editable
    });

    expect(allowed).toBe(false);
    handler.dispose();
  });

  it("emits approval.requested via session.approve roundtrip on AgentSession", async () => {
    const { AgentSession } = await import("../src/agent/conversation.mjs");
    const session = new AgentSession({
      settings: { approvalMode: "always-ask", session: { enabled: false }, agents: {}, tools: {} },
      sessionId: "approval-rt",
      cwd: process.cwd()
    });
    await session.initialize();
    const requested = [];
    session.events.on("approval.requested", (event) => {
      requested.push(event);
      setImmediate(() => session.approve(event.requestId, "allow"));
    });
    const allowed = await session.approvalRequester({
      kind: "write_file",
      summary: "x.txt",
      mutation: true,
      approvalMode: "always-ask"
    });
    expect(allowed).toBe(true);
    expect(requested).toHaveLength(1);
  });
});
