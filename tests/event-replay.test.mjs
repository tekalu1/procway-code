import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvent } from "../src/core/events/types.mjs";
import { messagesFromEvents } from "../src/core/projections/messages.mjs";
import { timelineFromEvents } from "../src/core/projections/timeline.mjs";
import { usageFromEvents } from "../src/core/projections/usage.mjs";
import { EventLog, readEventLog } from "../src/session/event-log.mjs";
import { getSessionDir } from "../src/session/store.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

function makeHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "procway-phase3-replay-"));
  tempDirs.push(dir);
  return dir;
}

describe("event replay projections", () => {
  it("returns empty / zero projections for empty input", () => {
    expect(messagesFromEvents([])).toEqual([]);
    expect(timelineFromEvents([])).toEqual([]);
    expect(usageFromEvents([])).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("projects user + assistant events into a 2-message conversation", () => {
    const events = [
      createEvent("user.prompt.submitted", {
        messageId: "u-1",
        sessionId: "s-1",
        content: [{ kind: "text", text: "hello" }]
      }),
      createEvent("assistant.message.completed", {
        messageId: "a-1",
        sessionId: "s-1",
        content: [{ kind: "text", text: "hi there" }]
      })
    ];
    const messages = messagesFromEvents(events);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: "u-1", role: "user", sessionId: "s-1" });
    expect(messages[0].content).toEqual([{ kind: "text", text: "hello" }]);
    expect(messages[1]).toMatchObject({ id: "a-1", role: "assistant" });
    expect(messages[1].content).toEqual([{ kind: "text", text: "hi there" }]);
  });

  it("restores reasoningContent onto the assistant message meta on resume (DeepSeek thinking-mode echo)", () => {
    // Regression: SiliconFlow code 20015. Before this fix, projecting an
    // assistant.message.completed event back into a Message dropped the
    // reasoning blob, so multi-turn resumed conversations were rejected
    // upstream. The fix adds reasoningContent to the event payload and
    // copies it into Message.meta.reasoningContent during replay.
    const events = [
      createEvent("user.prompt.submitted", {
        messageId: "u-1",
        sessionId: "s-1",
        content: [{ kind: "text", text: "go" }]
      }),
      createEvent("assistant.message.completed", {
        messageId: "a-1",
        sessionId: "s-1",
        content: [{ kind: "text", text: "ok" }],
        reasoningContent: "let me think about this carefully"
      })
    ];
    const messages = messagesFromEvents(events);
    expect(messages[1].meta).toEqual({ reasoningContent: "let me think about this carefully" });
  });

  it("does not attach meta when reasoningContent is missing or empty", () => {
    const events = [
      createEvent("assistant.message.completed", {
        messageId: "a-1",
        sessionId: "s-1",
        content: [{ kind: "text", text: "no reasoning" }]
      }),
      createEvent("assistant.message.completed", {
        messageId: "a-2",
        sessionId: "s-1",
        content: [{ kind: "text", text: "still no reasoning" }],
        reasoningContent: ""
      })
    ];
    const messages = messagesFromEvents(events);
    expect(messages[0].meta).toBeUndefined();
    expect(messages[1].meta).toBeUndefined();
  });

  it("sums usage.recorded events within the same round", () => {
    const events = [
      createEvent("usage.recorded", { round: 0, inputTokens: 100, outputTokens: 30, costUsd: 0.001 }),
      createEvent("usage.recorded", { round: 0, inputTokens: 200, outputTokens: 50, costUsd: 0.002 })
    ];
    expect(usageFromEvents(events)).toEqual({
      inputTokens: 300,
      outputTokens: 80,
      costUsd: 0.003
    });
  });

  it("pairs activity.started and activity.stopped into a single timeline entry", () => {
    const started = createEvent("activity.started", {
      activityId: "act-1",
      label: "model waiting",
      detail: "round=0"
    });
    const stopped = createEvent("activity.stopped", {
      activityId: "act-1",
      outcome: "response received"
    });
    const entries = timelineFromEvents([started, stopped]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      activityId: "act-1",
      label: "model waiting",
      detail: "round=0",
      startedAt: started.time,
      stoppedAt: stopped.time,
      outcome: "response received"
    });
  });

  it("phase1_C-1: writes events.jsonl via EventLog and re-reads them through readEventLog", async () => {
    const homeDir = makeHome();
    const sessionId = "s-roundtrip";
    const log = new EventLog({ homeDir, sessionId });
    const userEvent = createEvent("user.prompt.submitted", {
      sessionId,
      messageId: "u-1",
      content: [{ kind: "text", text: "hello" }]
    });
    const assistantEvent = createEvent("assistant.message.completed", {
      sessionId,
      messageId: "a-1",
      content: [{ kind: "text", text: "hi there" }]
    });
    await log.append(userEvent);
    await log.append(assistantEvent);

    const reloaded = await readEventLog({ homeDir, sessionId });
    expect(reloaded).toHaveLength(2);
    expect(reloaded[0]).toEqual(userEvent);
    expect(reloaded[1]).toEqual(assistantEvent);

    const messages = messagesFromEvents(reloaded);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual(userEvent.content);
    expect(messages[1].content).toEqual(assistantEvent.content);
  });

  it("phase1_C-1: tolerates malformed lines in events.jsonl during read", async () => {
    const homeDir = makeHome();
    const sessionId = "s-malformed";
    const dir = getSessionDir({ homeDir, sessionId });
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "events.jsonl");
    const valid = createEvent("user.prompt.submitted", {
      sessionId,
      messageId: "u-1",
      content: [{ kind: "text", text: "valid" }]
    });
    writeFileSync(
      filePath,
      `${JSON.stringify(valid)}\n{this is not json}\n`,
      "utf8"
    );
    const reloaded = await readEventLog({ homeDir, sessionId });
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toEqual(valid);
  });
});
