import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/conversation.mjs";
import { readEventLog } from "../src/session/event-log.mjs";
import { readSnapshot } from "../src/session/snapshot.mjs";
import { createEvent } from "../src/core/events/types.mjs";

let cwd;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "procway-flush-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("AgentSession.flushEventLog", () => {
  it("drains pending event-log appends before save() writes the snapshot", async () => {
    const session = new AgentSession({
      settings: { agents: {}, tools: {}, session: { enabled: true } },
      cwd,
      sessionId: "flush-1"
    });
    await session.initialize();

    for (let i = 0; i < 25; i += 1) {
      session.events.emit(createEvent("activity.tick", {
        sessionId: session.sessionId,
        activityId: `tick-${i}`,
        elapsedMs: i
      }));
    }
    await session.save({ force: true });

    const events = await readEventLog({ sessionId: session.sessionId });
    const ticks = events.filter((e) => e.type === "activity.tick");
    expect(ticks).toHaveLength(25);

    const snapshot = await readSnapshot({ sessionId: session.sessionId });
    expect(snapshot).toBeTruthy();
    expect(snapshot.eventCount).toBe(events.length);
  });
});
