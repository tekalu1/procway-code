import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { EventBus } from "../src/core/events/bus.mjs";
import { ApprovalCoordinator } from "../src/safety/approval.mjs";
import { attachBridge } from "../src/adapters/serve/bridge.mjs";

// ADR 0037 D5 — the approval coordinator must expose its pending requests as
// replay descriptors, and the serve bridge must re-emit them to a
// (re)attaching client. UIR widgets are NOT bridge-replayed any more: ADR 0037
// D1 (Phase 2) made every UIR record-and-return, so clients re-hydrate them
// from the durable pending_interactions rows instead (see
// useProcwayCodeSession.restorePendingInteractions).

describe("ApprovalCoordinator.listPending (ADR 0037)", () => {
  it("snapshots pending approvals with the full requested-event payload", async () => {
    const events = new EventBus();
    const coord = new ApprovalCoordinator({ events, defaultMode: "always-ask" });
    // always-ask never auto-resolves → the request stays pending.
    void coord.request({ kind: "run_shell", summary: "rm -rf tmp", payload: { cmd: "rm" }, sessionId: "s-1" });
    const pending = coord.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "run_shell", summary: "rm -rf tmp", payload: { cmd: "rm" }, sessionId: "s-1" });
    expect(typeof pending[0].requestId).toBe("string");
    // Resolving clears it from the snapshot.
    coord.resolve(pending[0].requestId, "allow");
    expect(coord.listPending()).toHaveLength(0);
  });
});

function fakeWs() {
  const emitter = new EventEmitter();
  const sent = [];
  emitter.send = (text) => { sent.push(text); };
  emitter.close = () => emitter.emit("close");
  emitter.sent = sent;
  return emitter;
}

describe("serve bridge pending replay (ADR 0037 D5)", () => {
  it("re-emits approval.requested on attach (no UIR replay — durable rows own those)", async () => {
    const events = new EventBus();
    const approvalCoordinator = new ApprovalCoordinator({ events, defaultMode: "always-ask" });
    void approvalCoordinator.request({ kind: "write_file", summary: "danger.txt", sessionId: "sess" });

    // Minimal session stub carrying only what the bridge attach path reads.
    const session = {
      sessionId: "sess",
      events,
      messages: [],
      eventCount: 0,
      runningTurn: false,
      todoStore: { list: () => [] },
      approvalCoordinator,
      flushEventLog: async () => {},
    };
    const ws = fakeWs();
    const { detach } = attachBridge({ session, ws, cwd: "/tmp" });

    const frames = ws.sent.map((t) => JSON.parse(t));
    const approval = frames.find((f) => f.kind === "event" && f.event?.type === "approval.requested");
    expect(approval?.event).toMatchObject({ kind: "write_file", summary: "danger.txt", sessionId: "sess" });
    const interaction = frames.find((f) => f.kind === "event" && f.event?.type === "interaction.requested");
    expect(interaction).toBeUndefined();
    await detach();
  });
});
