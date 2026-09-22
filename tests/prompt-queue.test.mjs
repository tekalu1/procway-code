import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { attachBridge } from "../src/adapters/serve/bridge.mjs";
import { readSnapshot } from "../src/session/snapshot.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = text => ({ message: { role: "assistant", content: text }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } });
async function makeSession(persist = false, sessionId = `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "prompt-queue-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const session = new AgentSession({ sessionId, cwd, wake: false, events: new EventBus(), settings: { session: { enabled: persist }, tools: { maxToolRounds: 2 }, agents: {} } });
  await session.initialize();
  return session;
}
function socket(session) {
  const ws = new EventEmitter();
  const frames = [];
  ws.send = raw => frames.push(JSON.parse(raw));
  const bridge = attachBridge({ session, ws });
  cleanups.push(() => bridge.detach());
  return { ws, frames, async command(command, args) {
    const id = Math.random().toString(36);
    ws.emit("message", JSON.stringify({ kind: "command", id, command, args }));
    await expect.poll(() => frames.find(f => f.kind === "response" && f.id === id)).toBeTruthy();
    return frames.find(f => f.kind === "response" && f.id === id);
  } };
}
const prompts = s => s.messages.filter(m => m.role === "user").map(m => m.content[0].text);

describe("session prompt queue through the serve bridge", () => {
  it("keeps a queued user instruction visible when the current turn is a background wake", async () => {
    const s = await makeSession(), started = gate(), finish = gate();
    const submitted = [];
    s.events.on("user.prompt.submitted", event => submitted.push(event));
    let calls = 0;
    const run = s.runTurn("<system-reminder>background work finished</system-reminder>", {
      wake: true,
      runProviderImpl: async () => { if (++calls === 1) { started.resolve(); await finish.promise; } return reply("done"); }
    });
    await started.promise;
    await s.promptQueue.enqueue("human", "please explain");
    finish.resolve(); await run;
    expect(submitted).toHaveLength(2);
    expect(submitted[0].wake).toBe(true);
    expect(submitted[1].wake).not.toBe(true);
  });

  it("holds prompts while approval is parked and drains after the approved continuation", async () => {
    const s = await makeSession(), finish = gate(), started = gate();
    s.settings.approvalMode = "always-ask";
    let calls = 0;
    const run = s.runTurn("write a file", { runProviderImpl: async () => {
      if (++calls === 1) {
        started.resolve(); await finish.promise;
        return { message: { role: "assistant", content: "" }, toolCalls: [{ id: "write1", name: "write_file", args: { filePath: "note.txt", content: "hello" } }], usage: {} };
      }
      return reply("done");
    } });
    await started.promise;
    await s.promptQueue.enqueue("after-approval", "explain it");
    finish.resolve();
    await run;
    expect(s.promptQueue.list()).toHaveLength(1);
    await s.promptQueue.enqueue("also-after", "", { attachments: [{ id: "a2", mime: "image/png" }] });
    expect(calls).toBe(1);
    const approval = s.listParkedApprovals()[0];
    await s.resolveParkedApproval(approval.requestId, "allow");
    await expect.poll(() => s.promptQueue.list()).toEqual([]);
    await expect.poll(() => s.promptQueue.active).toBe(false);
    expect(s.messages.filter(m => m.role === "user")).toHaveLength(3);
  });

  it("retains attachments, replays to another viewer and drains after the sender leaves", async () => {
    const s = await makeSession(), started = gate(), finish = gate();
    let calls = 0;
    const run = s.runTurn("first", { runProviderImpl: async () => { if (++calls === 1) { started.resolve(); await finish.promise; } return reply("done"); } });
    await started.promise;
    const sender = socket(s);
    const attachments = [{ id: "image-1", mime: "image/png", name: "screen.png" }, { id: "doc-1", mime: "text/plain", name: "notes.txt" }];
    expect((await sender.command("prompt.enqueue", { promptId: "q-1", prompt: "follow up", attachments })).ok).toBe(true);
    expect(prompts(s)).toEqual(["first"]);
    const viewer = socket(s);
    expect(viewer.frames.find(f => f.event?.type === "prompt.queue.updated").event.prompts).toEqual([{ id: "q-1", prompt: "follow up", attachments }]);
    sender.ws.emit("close");
    finish.resolve();
    await run;
    expect(prompts(s)).toEqual(["first", "follow up"]);
    expect(s.messages.find(m => m.role === "user" && m.content[0].text === "follow up").content).toContainEqual({ kind: "attachment_ref", id: "doc-1", mime: "text/plain", name: "notes.txt" });
    expect(viewer.frames.filter(f => f.event?.type === "turn.completed" && !f.event.continuing)).toHaveLength(1);
    expect(s.promptQueue.list()).toEqual([]);
  });

  it("Send now interrupts once and prioritizes that prompt without parallel turns", async () => {
    const s = await makeSession(), started = gate();
    let calls = 0, inFlight = 0, maximum = 0;
    const run = s.runTurn("first", { runProviderImpl: async ({ signal }) => {
      inFlight++; maximum = Math.max(maximum, inFlight);
      try {
        if (++calls === 1) { started.resolve(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
        return reply("done");
      } finally { inFlight--; }
    } });
    await started.promise;
    const viewer = socket(s);
    await viewer.command("prompt.enqueue", { promptId: "q-1", prompt: "later" });
    await viewer.command("prompt.enqueue", { promptId: "q-2", prompt: "urgent" });
    await viewer.command("prompt.sendNow", { promptId: "q-2" });
    await run;
    expect(prompts(s)).toEqual(["first", "urgent", "later"]);
    expect(maximum).toBe(1);
    expect(viewer.frames.some(f => f.event?.type === "turn.failed" && !f.event.continuing)).toBe(false);
  });

  it("accepts a prompt during the final snapshot save before telling the worker it is done", async () => {
    const s = await makeSession(), terminal = gate(), releaseSave = gate();
    const viewer = socket(s);
    let holding = false;
    const save = s.save.bind(s);
    s.events.on("turn.completed", () => { if (!holding) { holding = true; terminal.resolve(); } });
    s.save = async options => { if (holding) await releaseSave.promise; return save(options); };
    const run = s.runTurn("first", { runProviderImpl: async () => reply("done") });
    await terminal.promise;
    const queued = s.promptQueue.enqueue("late", "last second");
    expect(viewer.frames.filter(f => f.event?.type === "turn.completed" && !f.event.continuing)).toHaveLength(0);
    releaseSave.resolve();
    await queued; await run;
    expect(prompts(s)).toEqual(["first", "last second"]);
    expect(viewer.frames.filter(f => f.event?.type === "turn.completed" && !f.event.continuing)).toHaveLength(1);
  });

  it("Stop preserves the queue on disk and browsing a restored session never starts it", async () => {
    const s = await makeSession(true), started = gate();
    const run = s.runTurn("first", { runProviderImpl: async ({ signal }) => { started.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
    await started.promise;
    const viewer = socket(s);
    await viewer.command("prompt.enqueue", { promptId: "persisted", prompt: "later", attachments: [{ id: "a1", mime: "image/png" }] });
    await viewer.command("abort", {}); await run;
    expect((await readSnapshot({ sessionId: s.sessionId })).pendingPrompts).toHaveLength(1);
    const restored = await makeSession(true, s.sessionId);
    expect(restored.promptQueue.list()[0]).toMatchObject({ id: "persisted", attachments: [{ id: "a1", mime: "image/png" }] });
    socket(restored);
    expect(restored.runningTurn).toBe(false);
    await restored.promptQueue.remove("persisted");
    expect((await readSnapshot({ sessionId: s.sessionId })).pendingPrompts).toEqual([]);
  });
});
