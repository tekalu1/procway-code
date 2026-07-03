import { chmodSync, mkdtempSync, rmSync, mkdirSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  readSessionIndex,
  removeSessionIndex,
  upsertSessionIndex
} from "../src/session/session-index.mjs";
import { getSessionDir, getSessionsDir } from "../src/session/store.mjs";

const tempDirs = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

function makeHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "procway-session-index-"));
  tempDirs.push(dir);
  return dir;
}

describe("session-index", () => {
  it("upserts entries and persists them in index.json", async () => {
    const homeDir = makeHome();
    await upsertSessionIndex({
      homeDir,
      sessionId: "s-1",
      entry: { title: "first", provider: "p", model: "m", updatedAt: "2026-05-05", messageCount: 2 }
    });
    const index = await readSessionIndex({ homeDir });
    expect(index).toEqual({
      version: 3,
      sessions: { "s-1": { title: "first", provider: "p", model: "m", updatedAt: "2026-05-05", messageCount: 2 } }
    });
  });

  it("removeSessionIndex deletes a session entry", async () => {
    const homeDir = makeHome();
    await upsertSessionIndex({ homeDir, sessionId: "s-a", entry: { title: "a" } });
    await upsertSessionIndex({ homeDir, sessionId: "s-b", entry: { title: "b" } });
    await removeSessionIndex({ homeDir, sessionId: "s-a" });
    const index = await readSessionIndex({ homeDir });
    expect(Object.keys(index.sessions)).toEqual(["s-b"]);
  });

  it("rebuilds the index from meta.json files when index.json is missing", async () => {
    const homeDir = makeHome();
    const sessionId = "s-rebuild";
    const dir = getSessionDir({ homeDir, sessionId });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        sessionId,
        title: "rebuilt",
        provider: "anthropic",
        model: "claude-opus-4-7",
        updatedAt: "2026-05-05",
        messageCount: 3
      }),
      "utf8"
    );
    const index = await readSessionIndex({ homeDir });
    expect(index.sessions[sessionId]).toEqual({
      title: "rebuilt",
      provider: "anthropic",
      model: "claude-opus-4-7",
      updatedAt: "2026-05-05",
      createdAt: "2026-05-05",
      cwd: null,
      messageCount: 3,
      origin: null,
      sessionContext: null
    });
  });

  it("returns an empty index when sessions directory does not exist", async () => {
    const homeDir = makeHome();
    const index = await readSessionIndex({ homeDir });
    expect(index).toEqual({ version: 3, sessions: {} });
  });

  it("uses updatedAt as createdAt fallback when meta.json lacks createdAt (TK-126)", async () => {
    const homeDir = makeHome();
    const sessionId = "s-old";
    const dir = getSessionDir({ homeDir, sessionId });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        sessionId,
        title: "old",
        provider: "p",
        model: "m",
        updatedAt: "2026-04-01T00:00:00.000Z",
        messageCount: 1
      }),
      "utf8"
    );
    const index = await readSessionIndex({ homeDir });
    expect(index.sessions[sessionId].createdAt).toBe("2026-04-01T00:00:00.000Z");
    expect(index.sessions[sessionId].cwd).toBeNull();
  });

  it("encodeCursor / decodeCursor round-trip (TK-126)", () => {
    const original = { updatedAt: "2026-05-06T10:00:00.000Z", sessionId: "alpha" };
    const cursor = encodeCursor(original);
    expect(decodeCursor(cursor)).toEqual(original);
    expect(() => decodeCursor("")).toThrow();
    expect(() => decodeCursor(Buffer.from("nopipe", "utf8").toString("base64"))).toThrow();
  });

  // 共有ボリューム上の index.json は dashboard(uid 1000) と session Pod の
  // serve(root, CapDrop ALL = DAC_OVERRIDE なし) の両方が書く。先客が作った
  // 0644 を後客が open(O_WRONLY) すると EACCES → "session start failed"
  // (k8s 2026-06-06)。temp+rename は «ディレクトリ» の書込権限で判定される
  // ため、自分に書込ビットの無い既存 index も置き換えられることを検証する
  // （owner の w ビットを落とすのが非所有者 EACCES の代理）。
  it("replaces an index.json it cannot open for write (cross-writer EACCES)", async () => {
    const homeDir = makeHome();
    await upsertSessionIndex({ homeDir, sessionId: "s-1", entry: { title: "first" } });
    const indexFile = path.join(getSessionsDir({ homeDir }), "index.json");
    chmodSync(indexFile, 0o444);
    await upsertSessionIndex({ homeDir, sessionId: "s-2", entry: { title: "second" } });
    const index = await readSessionIndex({ homeDir });
    expect(Object.keys(index.sessions).sort()).toEqual(["s-1", "s-2"]);
    // 次の書き手（別 uid・補助 gid のみ共有）のために group-writable で残す
    expect(statSync(indexFile).mode & 0o777).toBe(0o664);
    // temp ファイルを残置しない
    const leftovers = readdirSync(getSessionsDir({ homeDir })).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("ignores `.legacy/` and other dotted directories during rebuild", async () => {
    const homeDir = makeHome();
    const sessionsDir = getSessionsDir({ homeDir });
    mkdirSync(path.join(sessionsDir, ".legacy"), { recursive: true });
    writeFileSync(path.join(sessionsDir, ".legacy", "noise.json"), "{}", "utf8");
    const index = await readSessionIndex({ homeDir });
    expect(index.sessions).toEqual({});
  });

  // #122 層1: same-process upsert/remove storms during a run loop used to share
  // an identical (non-random) tmp path and crash one writer with
  // `ENOENT: rename ...index.json.tmp-*`. With a random suffix + retry the
  // concurrent writes must all settle without throwing.
  it("survives concurrent upsert/remove without a tmp-rename collision", async () => {
    const homeDir = makeHome();
    const ops = [];
    for (let i = 0; i < 40; i++) {
      ops.push(upsertSessionIndex({ homeDir, sessionId: `s-${i}`, entry: { title: `t-${i}` } }));
      if (i % 2 === 0) ops.push(removeSessionIndex({ homeDir, sessionId: `s-${i}` }));
    }
    // The regression manifested as a rejected promise (ENOENT on rename) here.
    // NB: these ops are read-modify-write without a lock, so last-writer-wins
    // legitimately loses some entries — 層1 is about not CRASHING, not about
    // serializing the writes (a stale index self-heals via rebuild on read).
    await expect(Promise.all(ops)).resolves.toBeDefined();
    const index = await readSessionIndex({ homeDir });
    // the index survives the storm valid and readable, and leaks no temp files.
    expect(index.version).toBe(3);
    expect(index.sessions).toBeTypeOf("object");
    const leftovers = readdirSync(getSessionsDir({ homeDir })).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
