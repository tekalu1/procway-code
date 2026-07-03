import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { DEFAULT_SETTINGS } from "../src/config/default-settings.mjs";
import { EventLog } from "../src/session/event-log.mjs";
import { writeSnapshot } from "../src/session/snapshot.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { createMessage } from "../src/core/types/message.mjs";

let cwd;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-resume-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("AgentSession resume (phase3_E-2)", () => {
  it("replays trailing events.jsonl entries past the snapshot's eventCount", async () => {
    const sessionId = "resume-1";

    const systemMessage = createMessage({
      role: "system",
      sessionId,
      content: [{ kind: "text", text: "system" }]
    });
    const userMessage = createMessage({
      role: "user",
      sessionId,
      content: [{ kind: "text", text: "earlier prompt" }]
    });

    await writeSnapshot({
      sessionId,
      snapshot: {
        eventCount: 1,
        messages: [systemMessage, userMessage]
      }
    });

    // events.jsonl contains 1 event the snapshot already covers + 1 trailing
    // event the snapshot does not yet reflect.
    const log = new EventLog({ sessionId });
    await log.append(createEvent("user.prompt.submitted", {
      sessionId,
      messageId: userMessage.id,
      content: userMessage.content
    }));
    const trailingId = "trailing-msg";
    await log.append(createEvent("assistant.message.completed", {
      sessionId,
      messageId: trailingId,
      content: [{ kind: "text", text: "later answer" }]
    }));

    const session = new AgentSession({
      settings: { agents: {}, tools: {}, session: { enabled: true } },
      cwd,
      sessionId
    });
    await session.initialize();

    expect(session.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(session.messages[session.messages.length - 1].id).toBe(trailingId);
    expect(session.messages[session.messages.length - 1].content[0].text).toBe("later answer");
  });

  it("emits session.resumed (not session.created) when a snapshot exists", async () => {
    const sessionId = "resume-2";
    const systemMessage = createMessage({
      role: "system",
      sessionId,
      content: [{ kind: "text", text: "system" }]
    });
    await writeSnapshot({
      sessionId,
      snapshot: { eventCount: 0, messages: [systemMessage] }
    });

    const observed = [];
    const session = new AgentSession({
      settings: { agents: {}, tools: {}, session: { enabled: true } },
      cwd,
      sessionId
    });
    session.events.on("*", (event) => observed.push(event.type));
    await session.initialize();

    expect(observed).toContain("session.resumed");
    expect(observed).not.toContain("session.created");
  });

  // Regression: when a run dies mid-turn (process crash, container exit,
  // tool ENOENT, …), the snapshot only captures whatever was saved before
  // the failure — typically just the initial system message. The bridge
  // used to pre-load `state.messages` from the snapshot when resuming via
  // `?resume=`, which short-circuited AgentSession.initialize()'s
  // events.jsonl replay (the guard `this.messages.length === 0` only
  // restores when nothing was pre-loaded). Dashboard then saw a 1-message
  // transcript with only a system entry, the projection filtered it out,
  // and the chat panel rendered blank — even though events.jsonl had the
  // user's prompt and any partial assistant output. We resume with no
  // pre-loaded messages now and let initialize() do the full restore.
  it("replays user/assistant events.jsonl entries even when the snapshot only contains the initial system message", async () => {
    const sessionId = "resume-mid-turn-crash";
    const systemMessage = createMessage({
      role: "system",
      sessionId,
      content: [{ kind: "text", text: "system" }]
    });

    // Snapshot is what the runtime wrote at session.created time — before
    // the user even submitted a prompt.
    await writeSnapshot({
      sessionId,
      snapshot: { eventCount: 1, messages: [systemMessage] }
    });

    // events.jsonl has the prompt + a partial assistant message that the
    // run never got to persist into the snapshot.
    const log = new EventLog({ sessionId });
    await log.append(createEvent("session.created", {
      sessionId, cwd: "/tmp", provider: "stub", model: "stub-1"
    }));
    await log.append(createEvent("user.prompt.submitted", {
      sessionId,
      messageId: "u-1",
      content: [{ kind: "text", text: "do the thing" }]
    }));
    await log.append(createEvent("assistant.message.completed", {
      sessionId,
      messageId: "a-1",
      content: [{ kind: "text", text: "starting on it" }]
    }));

    // Reproduce the bridge's defaultSessionFactory behavior: it loads the
    // snapshot and passes its `messages` straight into the constructor.
    // Before the fix, that pre-load short-circuited #restoreFromPersistence
    // (`messages.length === 0` was false), so trailing events.jsonl never
    // got replayed and the dashboard saw only the system message.
    const session = new AgentSession({
      settings: { agents: {}, tools: {}, session: { enabled: true } },
      cwd,
      sessionId,
      messages: [systemMessage]
    });
    await session.initialize();

    expect(session.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(session.messages.at(-1).content[0].text).toBe("starting on it");
  });

  // The system message is frozen at session-creation time, so a resumed
  // session used to keep a stale "## Available Skills" index (e.g. skills
  // added to the worktree after the session was first created were never
  // announced). Resume now re-scans the workspace and swaps the section.
  it("refreshes the Available Skills section of the system message on resume", async () => {
    const sessionId = "resume-skills-refresh";
    await mkdir(path.join(cwd, "skills", "fresh"), { recursive: true });
    await writeFile(
      path.join(cwd, "skills", "fresh", "SKILL.md"),
      "---\nname: fresh\ndescription: Newly added skill\n---\n\nbody",
      "utf8"
    );

    const staleSystemMessage = createMessage({
      role: "system",
      sessionId,
      content: [{
        kind: "text",
        text: "intro\n\n## Available Skills\n- /gone/skills/stale/SKILL.md (shared, priority 80)\n"
      }]
    });
    await writeSnapshot({
      sessionId,
      snapshot: { eventCount: 0, messages: [staleSystemMessage] }
    });

    const session = new AgentSession({
      settings: { ...DEFAULT_SETTINGS, session: { enabled: true } },
      cwd,
      sessionId
    });
    await session.initialize();

    const text = session.messages[0].content[0].text;
    expect(text).toContain("- fresh: Newly added skill (");
    expect(text).toContain(path.join(cwd, "skills", "fresh", "SKILL.md"));
    expect(text).not.toContain("/gone/skills/stale/SKILL.md");
    expect(text.startsWith("intro\n\n## Available Skills\n")).toBe(true);
  });
});
