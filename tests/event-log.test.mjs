import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, appendEvent, readEventLog } from "../src/session/event-log.mjs";
import { getSessionDir } from "../src/session/store.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { deriveKeyFromPassphrase, ENCRYPTION_MAGIC } from "../src/session/encryption.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

function makeHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "procway-event-log-"));
  tempDirs.push(dir);
  return dir;
}

describe("EventLog", () => {
  it("appends events to events.jsonl and reads them back in order", async () => {
    const homeDir = makeHome();
    const sessionId = "s-append";
    const log = new EventLog({ homeDir, sessionId });
    const events = [
      createEvent("session.created", { sessionId, cwd: homeDir, provider: "p", model: "m" }),
      createEvent("user.prompt.submitted", { sessionId, messageId: "u-1", content: [{ kind: "text", text: "hi" }] }),
      createEvent("assistant.message.completed", { sessionId, messageId: "a-1", content: [{ kind: "text", text: "ok" }] })
    ];
    for (const event of events) await log.append(event);

    const reloaded = await log.readAll();
    expect(reloaded).toEqual(events);
  });

  it("rejects values that fail isAgentEvent", async () => {
    const homeDir = makeHome();
    const log = new EventLog({ homeDir, sessionId: "s-reject" });
    await expect(log.append({ type: "not-an-event" })).rejects.toBeInstanceOf(TypeError);
  });

  it("returns the last N events via tail()", async () => {
    const homeDir = makeHome();
    const sessionId = "s-tail";
    const log = new EventLog({ homeDir, sessionId });
    for (let i = 0; i < 5; i += 1) {
      await log.append(createEvent("turn.completed", { sessionId, round: i, exitCode: 0 }));
    }
    const tail = await log.tail(2);
    expect(tail).toHaveLength(2);
    expect(tail[0].round).toBe(3);
    expect(tail[1].round).toBe(4);
  });

  it("skips invalid lines on read instead of throwing", async () => {
    const homeDir = makeHome();
    const sessionId = "s-malformed";
    const dir = getSessionDir({ homeDir, sessionId });
    mkdirSync(dir, { recursive: true });
    const valid = createEvent("turn.completed", { sessionId, round: 0, exitCode: 0 });
    writeFileSync(
      path.join(dir, "events.jsonl"),
      `${JSON.stringify(valid)}\nnot-json{\n${JSON.stringify(createEvent("turn.completed", { sessionId, round: 1, exitCode: 0 }))}\n`,
      "utf8"
    );
    const reloaded = await readEventLog({ homeDir, sessionId });
    expect(reloaded).toHaveLength(2);
    expect(reloaded[0]).toEqual(valid);
    expect(reloaded[1].round).toBe(1);
  });

  it("survives concurrent appendEvent helper calls without losing entries", async () => {
    const homeDir = makeHome();
    const sessionId = "s-concurrent";
    const events = Array.from({ length: 10 }, (_, i) =>
      createEvent("turn.completed", { sessionId, round: i, exitCode: 0 })
    );
    await Promise.all(events.map((event) => appendEvent({ homeDir, sessionId, event })));
    const reloaded = await readEventLog({ homeDir, sessionId });
    expect(reloaded).toHaveLength(events.length);
    const observedRounds = reloaded.map((event) => event.round).sort((a, b) => a - b);
    expect(observedRounds).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("preserves append order for unawaited concurrent appends on one instance", async () => {
    // The session-level subscriber fires append per event without awaiting
    // the previous one. Unserialized, two near-simultaneous appends could
    // interleave their mkdir/appendFile awaits and land on disk reversed —
    // observed in the wild as a tool.call.completed written BEFORE its
    // assistant.message.completed, which poisons the history a resume
    // projects from file order. The instance write chain must keep file
    // order identical to append order.
    const homeDir = makeHome();
    const sessionId = "s-ordered";
    const log = new EventLog({ homeDir, sessionId });
    const events = Array.from({ length: 25 }, (_, i) =>
      createEvent("turn.completed", { sessionId, round: i, exitCode: 0 })
    );
    await Promise.all(events.map((event) => log.append(event)));
    const reloaded = await log.readAll();
    expect(reloaded.map((event) => event.round)).toEqual(events.map((event) => event.round));
  });

  it("keeps the write chain alive after a rejected append", async () => {
    const homeDir = makeHome();
    const sessionId = "s-chain";
    const log = new EventLog({ homeDir, sessionId });
    await expect(log.append({ type: "not-an-event" })).rejects.toBeInstanceOf(TypeError);
    const event = createEvent("turn.completed", { sessionId, round: 0, exitCode: 0 });
    await log.append(event);
    expect(await log.readAll()).toEqual([event]);
  });

  it("returns [] when the events.jsonl file does not yet exist", async () => {
    const homeDir = makeHome();
    const sessionId = "s-empty";
    expect(await readEventLog({ homeDir, sessionId })).toEqual([]);
  });

  it("redacts secrets before writing to disk while keeping callers' copies intact", async () => {
    const homeDir = makeHome();
    const sessionId = "s-redact";
    const log = new EventLog({ homeDir, sessionId, redactionPatterns: [/sk-[A-Za-z0-9]+/g] });
    const event = createEvent("user.prompt.submitted", {
      sessionId,
      messageId: "u-1",
      content: [{ kind: "text", text: "OPENAI_KEY=sk-secretvalue123" }]
    });
    await log.append(event);

    expect(event.content[0].text).toContain("sk-secretvalue123");
    const written = await log.readAll();
    expect(written[0].content[0].text).not.toContain("sk-secretvalue123");
    expect(written[0].content[0].text).toContain("[REDACTED]");
  });

  it("round-trips encrypted events when an encryption key is provided", async () => {
    const homeDir = makeHome();
    const sessionId = "s-encrypted";
    const key = deriveKeyFromPassphrase("phase6-test");
    const log = new EventLog({ homeDir, sessionId, encryptionKey: key });
    const event = createEvent("session.created", { sessionId, cwd: homeDir, provider: "p", model: "m" });
    await log.append(event);

    const filePath = path.join(getSessionDir({ homeDir, sessionId }), "events.jsonl");
    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain("session.created");

    const decoded = Buffer.from(onDisk.trim(), "base64").slice(0, ENCRYPTION_MAGIC.length).toString("utf8");
    expect(decoded).toBe(ENCRYPTION_MAGIC);

    const reloaded = await log.readAll();
    expect(reloaded[0]).toEqual(event);
  });
});
