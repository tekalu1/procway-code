import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SNAPSHOT_INTERVAL,
  isSnapshotStale,
  readSnapshot,
  writeArchivedSnapshot,
  writeSnapshot
} from "../src/session/snapshot.mjs";
import { getSessionDir } from "../src/session/store.mjs";
import { deriveKeyFromPassphrase, ENCRYPTION_MAGIC, isEncryptedBuffer } from "../src/session/encryption.mjs";
import { readFileSync } from "node:fs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

function makeHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "procway-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

describe("snapshot", () => {
  it("writes and reads a snapshot.json round-trip", async () => {
    const homeDir = makeHome();
    const sessionId = "s-1";
    const messages = [
      { id: "m-1", sessionId, role: "user", content: [{ kind: "text", text: "hi" }] }
    ];
    const written = await writeSnapshot({
      homeDir,
      sessionId,
      snapshot: { eventCount: 7, messages }
    });
    expect(written.snapshotId).toMatch(/[0-9a-f-]+/i);
    expect(written.eventCount).toBe(7);
    expect(written.messages).toEqual(messages);
    expect(written.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });

    const reloaded = await readSnapshot({ homeDir, sessionId });
    expect(reloaded).toEqual(written);
  });

  it("returns null when snapshot.json is absent", async () => {
    const homeDir = makeHome();
    expect(await readSnapshot({ homeDir, sessionId: "s-missing" })).toBeNull();
  });

  it("returns null when snapshot.json is corrupt", async () => {
    const homeDir = makeHome();
    const sessionId = "s-corrupt";
    const dir = getSessionDir({ homeDir, sessionId });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "snapshot.json"), "{this is not json", "utf8");
    expect(await readSnapshot({ homeDir, sessionId })).toBeNull();
  });

  it("isSnapshotStale flips at SNAPSHOT_INTERVAL", async () => {
    const homeDir = makeHome();
    const sessionId = "s-stale";
    await writeSnapshot({ homeDir, sessionId, snapshot: { eventCount: 100, messages: [] } });
    expect(await isSnapshotStale({ homeDir, sessionId, eventCount: 100 + SNAPSHOT_INTERVAL - 1 })).toBe(false);
    expect(await isSnapshotStale({ homeDir, sessionId, eventCount: 100 + SNAPSHOT_INTERVAL })).toBe(true);
  });

  it("isSnapshotStale returns true when no snapshot exists", async () => {
    const homeDir = makeHome();
    expect(await isSnapshotStale({ homeDir, sessionId: "s-none", eventCount: 1 })).toBe(true);
  });

  it("writeArchivedSnapshot stores a frozen copy under a custom filename", async () => {
    const homeDir = makeHome();
    const sessionId = "s-archive";
    const messages = [{ id: "m-x", sessionId, role: "user", content: [{ kind: "text", text: "x" }] }];
    const { filePath, snapshot } = await writeArchivedSnapshot({
      homeDir,
      sessionId,
      name: "pre-compact-42",
      snapshot: { eventCount: 42, messages }
    });
    expect(filePath.endsWith("pre-compact-42.json")).toBe(true);
    expect(snapshot.eventCount).toBe(42);
    expect(snapshot.messages).toEqual(messages);
  });

  it("encrypts snapshot.json on disk and round-trips through readSnapshot", async () => {
    const homeDir = makeHome();
    const sessionId = "s-encrypted";
    const key = deriveKeyFromPassphrase("phase6-snapshot");
    const messages = [{ id: "m-1", sessionId, role: "user", content: [{ kind: "text", text: "encrypted hello" }] }];
    const written = await writeSnapshot({
      homeDir,
      sessionId,
      snapshot: { eventCount: 3, messages },
      encryptionKey: key
    });
    expect(written.eventCount).toBe(3);

    const filePath = path.join(getSessionDir({ homeDir, sessionId }), "snapshot.json");
    const onDisk = readFileSync(filePath);
    expect(isEncryptedBuffer(onDisk)).toBe(true);
    expect(onDisk.slice(0, ENCRYPTION_MAGIC.length).toString("utf8")).toBe(ENCRYPTION_MAGIC);

    const reloaded = await readSnapshot({ homeDir, sessionId, encryptionKey: key });
    expect(reloaded?.messages).toEqual(messages);

    const withoutKey = await readSnapshot({ homeDir, sessionId });
    expect(withoutKey).toBeNull();
  });
});
