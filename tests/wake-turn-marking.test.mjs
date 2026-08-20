// event-wake (issue #143) — a wake turn must be DISTINGUISHABLE from something
// the user typed, on every surface.
//
// The bug this pins: the supervisor injects its wake as a user-role message
// whose entire body is a `<system-reminder>`. Every display surface strips a
// leading reminder block (so the runtime-only preambles never leak into the
// UI), which left this message with NO visible text at all — a small empty
// grey bubble in the dashboard chat and a bodiless `## You` in transcript.md.
// From the user's side that reads as a message they never sent.
//
// The mark is a plain `wake: true` flag on the Message (the same shape
// `compacted` uses on a compaction summary), which the transcript projection
// turns into a node kind of its own.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { EventBus } from "../src/core/events/bus.mjs";
import { transcriptFromMessages } from "../src/core/projections/transcript.mjs";
import { renderTranscriptMarkdown } from "../src/session/transcript-md.mjs";

const WAKE_BODY = [
  "<system-reminder>",
  "AUTOMATIC RESUME — this is NOT a message from the user. Background work you started has settled.",
  "",
  "Settled (1):",
  "- run run-1 — completed (acme#TK-1)",
  "</system-reminder>"
].join("\n");

let dirs = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function makeSession(sessionId) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "procway-wake-mark-"));
  dirs.push(cwd);
  const session = new AgentSession({
    settings: {
      defaultProvider: "scripted",
      approvalMode: "full-auto",
      tools: { maxToolRounds: 2 },
      providers: { scripted: { type: "openai-compatible", baseUrl: "https://example.test/v1", apiKeyEnv: "NOPE", defaultModel: "m" } },
      session: { enabled: false }
    },
    cwd,
    sessionId,
    events: new EventBus()
  });
  await session.initialize();
  return session;
}

/** One provider round that answers with plain text and no tool calls. */
const answer = async () => ({ message: { role: "assistant", content: "collected, continuing." } });

describe("wake turns are marked, not silently empty", () => {
  it("marks the stored message and the emitted prompt event", async () => {
    const session = await makeSession("s-wake-mark");
    const prompts = [];
    session.events.on("user.prompt.submitted", (event) => prompts.push(event));

    await session.runTurn("hello", { runProviderImpl: answer });
    await session.runTurn(WAKE_BODY, { wake: true, runProviderImpl: answer });

    const users = session.messages.filter((m) => m.role === "user");
    expect(users[0].wake).toBeUndefined();
    expect(users[1].wake).toBe(true);

    expect(prompts).toHaveLength(2);
    expect(prompts[0].wake).toBeUndefined();
    expect(prompts[1].wake).toBe(true);

    session.wakeSupervisor?.stop();
  });

  it("projects the wake as its own node and never as an empty user bubble", async () => {
    const session = await makeSession("s-wake-project");
    await session.runTurn("hello", { runProviderImpl: answer });
    await session.runTurn(WAKE_BODY, { wake: true, runProviderImpl: answer });

    const nodes = transcriptFromMessages(session.messages);
    expect(nodes.filter((n) => n.kind === "wake")).toHaveLength(1);
    expect(nodes.filter((n) => n.kind === "user").map((n) => n.text)).toEqual(["hello"]);
    // The precise regression: a user node whose visible text stripped to "".
    expect(nodes.some((n) => n.kind === "user" && n.text.trim() === "")).toBe(false);

    const md = renderTranscriptMarkdown({ sessionId: session.sessionId, messages: session.messages });
    expect(md).toContain("## Automatic resume");
    expect(md.match(/## You/g)).toHaveLength(1);

    session.wakeSupervisor?.stop();
  });

  it("does not let a wake become the session title", async () => {
    // A session resumed cold purely to collect background work can have the
    // wake as its FIRST turn; the reminder body must not end up in the sidebar.
    const session = await makeSession("s-wake-title");
    await session.runTurn(WAKE_BODY, { wake: true, runProviderImpl: answer });
    expect(session.title).toBeFalsy();

    await session.runTurn("now something I typed", { runProviderImpl: answer });
    expect(session.title).toBe("now something I typed");

    session.wakeSupervisor?.stop();
  });

  it("the supervisor's default injector marks the turn it starts", async () => {
    // The mark is only useful if the path that actually produces wakes sets it.
    const session = await makeSession("s-wake-injector");
    const calls = [];
    session.runTurn = async (text, options) => { calls.push({ text, options }); };

    session.wakeSupervisor.pushExternal({
      jobId: "run-1", kind: "run", status: "completed", project: "acme", ticket: "TK-1"
    });
    await session.wakeSupervisor.flushNow();

    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ wake: true });
    expect(calls[0].text).toContain("AUTOMATIC RESUME");

    session.wakeSupervisor.stop();
  });
});
