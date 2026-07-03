import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getSessionPaths,
  listSessions,
  loadSessionState,
  saveSessionState
} from "../src/session/store.mjs";
import { decodeCursor, encodeCursor } from "../src/session/session-index.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
  tempDirs = [];
});

describe("session store (Phase 3 layout)", () => {
  it("writes <id>/{snapshot.json, meta.json} + index.json and round-trips", async () => {
    const homeDir = await makeHome();
    const workspace = "/proj/example";
    await saveSessionState({
      homeDir,
      sessionId: "session-a",
      state: {
        sessionId: "session-a",
        title: "hello",
        cwd: workspace,
        provider: "openrouter",
        model: "model-a",
        updatedAt: "2026-01-01T00:00:00.000Z",
        eventCount: 3,
        messages: [{ role: "user", content: "hi", id: "m-1", sessionId: "session-a" }]
      }
    });

    const paths = getSessionPaths({ homeDir, sessionId: "session-a" });
    expect(existsSync(paths.snapshotPath)).toBe(true);
    expect(existsSync(paths.metaPath)).toBe(true);
    const snapshot = JSON.parse(await readFile(paths.snapshotPath, "utf8"));
    expect(snapshot).toEqual(expect.objectContaining({
      eventCount: 3,
      messages: [{ role: "user", content: "hi", id: "m-1", sessionId: "session-a" }]
    }));
    const meta = JSON.parse(await readFile(paths.metaPath, "utf8"));
    expect(meta).toEqual(expect.objectContaining({
      sessionId: "session-a",
      title: "hello",
      provider: "openrouter",
      model: "model-a",
      cwd: path.resolve(workspace),
      messageCount: 1
    }));

    const indexPath = path.join(path.dirname(paths.dir), "index.json");
    expect(existsSync(indexPath)).toBe(true);

    const loaded = await loadSessionState({ homeDir, sessionId: "session-a" });
    expect(loaded).toEqual(expect.objectContaining({
      sessionId: "session-a",
      title: "hello",
      provider: "openrouter",
      model: "model-a",
      eventCount: 3
    }));
    expect(loaded.messages).toEqual(snapshot.messages);

    const { sessions, nextCursor } = await listSessions({ homeDir, cwd: null });
    expect(sessions).toEqual([expect.objectContaining({
      sessionId: "session-a",
      title: "hello",
      model: "model-a",
      messageCount: 1
    })]);
    expect(nextCursor).toBeNull();
  });

  it("rebuilds the index from meta.json files when index.json is absent", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "session-b",
      state: {
        title: "bee",
        provider: "openrouter",
        model: "model-b",
        updatedAt: "2026-02-02T00:00:00.000Z",
        messages: []
      }
    });
    // Simulate index loss.
    const paths = getSessionPaths({ homeDir, sessionId: "session-b" });
    const indexPath = path.join(path.dirname(paths.dir), "index.json");
    await rm(indexPath, { force: true });

    const { sessions } = await listSessions({ homeDir, cwd: null });
    expect(sessions).toEqual([expect.objectContaining({
      sessionId: "session-b",
      title: "bee",
      model: "model-b"
    })]);
  });
});

async function makeHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procway-code-store-"));
  tempDirs.push(dir);
  return dir;
}

describe("session store — listSessions paging (TK-126)", () => {
  it("returns the full set of fields with createdAt and cwd", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "s-fields",
      state: {
        title: "t",
        provider: "anthropic",
        model: "claude-sonnet",
        updatedAt: "2026-05-06T10:00:00.000Z",
        cwd: "/proj",
        messages: []
      }
    });
    const { sessions, nextCursor } = await listSessions({ homeDir, cwd: null });
    expect(nextCursor).toBeNull();
    const entry = sessions.find((s) => s.sessionId === "s-fields");
    expect(entry).toBeDefined();
    expect(Object.keys(entry).sort()).toEqual(
      ["createdAt", "cwd", "messageCount", "model", "origin", "provider", "sessionContext", "sessionId", "title", "updatedAt"]
    );
    expect(entry.sessionContext).toBeNull();
    expect(entry.cwd).toBe(path.resolve("/proj"));
    expect(entry.createdAt).toBe("2026-05-06T10:00:00.000Z");
  });

  it("paginates with cursor, returning ordered pages without duplicates", async () => {
    const homeDir = await makeHome();
    for (let i = 0; i < 7; i += 1) {
      await saveSessionState({
        homeDir,
        sessionId: `p-${i}`,
        state: {
          title: `p${i}`,
          provider: "p",
          model: "m",
          updatedAt: `2026-05-0${i + 1}T00:00:00.000Z`,
          messages: []
        }
      });
    }
    const first = await listSessions({ homeDir, cwd: null, limit: 3 });
    expect(first.sessions.map((s) => s.sessionId)).toEqual(["p-6", "p-5", "p-4"]);
    expect(typeof first.nextCursor).toBe("string");
    const second = await listSessions({ homeDir, cwd: null, limit: 3, cursor: first.nextCursor });
    expect(second.sessions.map((s) => s.sessionId)).toEqual(["p-3", "p-2", "p-1"]);
    expect(typeof second.nextCursor).toBe("string");
    const third = await listSessions({ homeDir, cwd: null, limit: 3, cursor: second.nextCursor });
    expect(third.sessions.map((s) => s.sessionId)).toEqual(["p-0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("uses sessionId DESC as a stable tiebreak when updatedAt collides", async () => {
    const homeDir = await makeHome();
    const updatedAt = "2026-05-01T00:00:00.000Z";
    for (const sessionId of ["A", "B", "C"]) {
      await saveSessionState({
        homeDir,
        sessionId,
        state: { title: sessionId, provider: "p", model: "m", updatedAt, messages: [] }
      });
    }
    const first = await listSessions({ homeDir, cwd: null, limit: 2 });
    expect(first.sessions.map((s) => s.sessionId)).toEqual(["C", "B"]);
    const second = await listSessions({ homeDir, cwd: null, limit: 2, cursor: first.nextCursor });
    expect(second.sessions.map((s) => s.sessionId)).toEqual(["A"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns an empty array and null cursor when there are no sessions", async () => {
    const homeDir = await makeHome();
    const result = await listSessions({ homeDir, cwd: null });
    expect(result.sessions).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("rejects out-of-range limit", async () => {
    const homeDir = await makeHome();
    await expect(listSessions({ homeDir, cwd: null, limit: 0 })).rejects.toThrow(/limit/);
    await expect(listSessions({ homeDir, cwd: null, limit: 201 })).rejects.toThrow(/limit/);
  });

  it("encodeCursor + decodeCursor round-trip preserves the original pair", () => {
    const original = { updatedAt: "2026-05-06T10:00:00.000Z", sessionId: "abc-123" };
    const encoded = encodeCursor(original);
    expect(typeof encoded).toBe("string");
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(original);
  });

  it("filters by cwd when a non-null cwd is supplied", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "in-A",
      state: { title: "A", provider: "p", model: "m", cwd: "/projects/alpha", updatedAt: "2026-05-10T00:00:00.000Z", messages: [] }
    });
    await saveSessionState({
      homeDir,
      sessionId: "in-B",
      state: { title: "B", provider: "p", model: "m", cwd: "/projects/beta", updatedAt: "2026-05-11T00:00:00.000Z", messages: [] }
    });

    const all = await listSessions({ homeDir, cwd: null });
    expect(all.sessions.map((s) => s.sessionId).sort()).toEqual(["in-A", "in-B"]);

    const onlyAlpha = await listSessions({ homeDir, cwd: "/projects/alpha" });
    expect(onlyAlpha.sessions.map((s) => s.sessionId)).toEqual(["in-A"]);

    const onlyBeta = await listSessions({ homeDir, cwd: "/projects/beta" });
    expect(onlyBeta.sessions.map((s) => s.sessionId)).toEqual(["in-B"]);
  });
});

describe("session store — origin tag filtering", () => {
  async function seedMixedOrigins(homeDir) {
    await saveSessionState({
      homeDir,
      sessionId: "user-chat",
      state: { title: "chat", provider: "p", model: "m", updatedAt: "2026-06-03T00:00:00.000Z", messages: [] }
    });
    await saveSessionState({
      homeDir,
      sessionId: "worker-run",
      state: { title: "run", provider: "p", model: "m", origin: "worker", updatedAt: "2026-06-02T00:00:00.000Z", messages: [] }
    });
    // Legacy runner session: predates the origin tag but carries procwayMeta
    // — saveSessionState backfills origin: "worker" from it.
    await saveSessionState({
      homeDir,
      sessionId: "legacy-runner",
      state: {
        title: "legacy",
        provider: "p",
        model: "m",
        procwayMeta: { project: "proc", ticket: "TK-1", task: "impl", interactive: false },
        updatedAt: "2026-06-01T00:00:00.000Z",
        messages: []
      }
    });
  }

  it("origin: 'user' keeps only origin-less sessions; tagged origins match exactly", async () => {
    const homeDir = await makeHome();
    await seedMixedOrigins(homeDir);

    const all = await listSessions({ homeDir, cwd: null });
    expect(all.sessions.map((s) => s.sessionId)).toEqual(["user-chat", "worker-run", "legacy-runner"]);

    const users = await listSessions({ homeDir, cwd: null, origin: "user" });
    expect(users.sessions.map((s) => s.sessionId)).toEqual(["user-chat"]);
    expect(users.sessions[0].origin).toBeNull();

    const workers = await listSessions({ homeDir, cwd: null, origin: "worker" });
    expect(workers.sessions.map((s) => s.sessionId)).toEqual(["worker-run", "legacy-runner"]);
  });

  it("origin array matches ANY term — ['user','slack'] = sidebar incl. Slack convos (ADR 0021)", async () => {
    const homeDir = await makeHome();
    await seedMixedOrigins(homeDir);
    await saveSessionState({
      homeDir,
      sessionId: "slack-thread",
      state: { title: "from slack", provider: "p", model: "m", origin: "slack", updatedAt: "2026-06-04T00:00:00.000Z", messages: [] }
    });

    const sidebar = await listSessions({ homeDir, cwd: null, origin: ["user", "slack"] });
    expect(sidebar.sessions.map((s) => s.sessionId)).toEqual(["slack-thread", "user-chat"]);

    const slackOnly = await listSessions({ homeDir, cwd: null, origin: ["slack"] });
    expect(slackOnly.sessions.map((s) => s.sessionId)).toEqual(["slack-thread"]);

    // Empty array = no filter (same as null), not "match nothing".
    const everything = await listSessions({ homeDir, cwd: null, origin: [] });
    expect(everything.sessions).toHaveLength(4);
  });

  it("applies the origin filter before pagination so cursors stay stable", async () => {
    const homeDir = await makeHome();
    for (let i = 0; i < 5; i += 1) {
      await saveSessionState({
        homeDir,
        sessionId: `u-${i}`,
        state: { title: `u${i}`, provider: "p", model: "m", updatedAt: `2026-06-0${i + 1}T00:00:00.000Z`, messages: [] }
      });
      await saveSessionState({
        homeDir,
        sessionId: `w-${i}`,
        state: { title: `w${i}`, provider: "p", model: "m", origin: "worker", updatedAt: `2026-06-0${i + 1}T12:00:00.000Z`, messages: [] }
      });
    }
    const first = await listSessions({ homeDir, cwd: null, origin: "user", limit: 3 });
    expect(first.sessions.map((s) => s.sessionId)).toEqual(["u-4", "u-3", "u-2"]);
    expect(typeof first.nextCursor).toBe("string");
    const second = await listSessions({ homeDir, cwd: null, origin: "user", limit: 3, cursor: first.nextCursor });
    expect(second.sessions.map((s) => s.sessionId)).toEqual(["u-1", "u-0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("keeps the origin sticky across saves that omit it (ChatPanel takeover)", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "sticky-worker",
      state: { title: "first", provider: "p", model: "m", origin: "worker", updatedAt: "2026-06-01T00:00:00.000Z", messages: [] }
    });
    await saveSessionState({
      homeDir,
      sessionId: "sticky-worker",
      state: { title: "second", provider: "p", model: "m", updatedAt: "2026-06-02T00:00:00.000Z", messages: [] }
    });
    const paths = getSessionPaths({ homeDir, sessionId: "sticky-worker" });
    const meta = JSON.parse(await readFile(paths.metaPath, "utf8"));
    expect(meta.origin).toBe("worker");
    const users = await listSessions({ homeDir, cwd: null, origin: "user" });
    expect(users.sessions).toEqual([]);
  });

  it("migrates a v1 index (no origin) by rebuilding from meta.json and persisting the current version", async () => {
    const homeDir = await makeHome();
    await seedMixedOrigins(homeDir);
    const paths = getSessionPaths({ homeDir, sessionId: "user-chat" });
    const indexPath = path.join(path.dirname(paths.dir), "index.json");
    // Forge a stale v1 index: entries lack `origin`/`sessionContext`, version 1.
    const current = JSON.parse(await readFile(indexPath, "utf8"));
    const v1Sessions = Object.fromEntries(
      Object.entries(current.sessions).map(([id, entry]) => {
        const { origin: _dropped, sessionContext: _dropped2, ...rest } = entry;
        return [id, rest];
      })
    );
    await writeFile(indexPath, JSON.stringify({ version: 1, sessions: v1Sessions }, null, 2) + "\n", "utf8");

    const users = await listSessions({ homeDir, cwd: null, origin: "user" });
    expect(users.sessions.map((s) => s.sessionId)).toEqual(["user-chat"]);

    // The rebuild is persisted so the migration doesn't repeat on every read.
    const persisted = JSON.parse(await readFile(indexPath, "utf8"));
    expect(persisted.version).toBe(3);
    expect(persisted.sessions["legacy-runner"].origin).toBe("worker");
    expect(persisted.sessions["user-chat"].origin).toBeNull();
    // v3: legacy runner backfills sessionContext from procwayMeta on rebuild.
    expect(persisted.sessions["legacy-runner"].sessionContext).toEqual({ project: "proc", ticket: "TK-1" });
    expect(persisted.sessions["user-chat"].sessionContext ?? null).toBeNull();
  });
});

describe("session store — sessionContext tag (Phase 0)", () => {
  it("round-trips an explicit sessionContext through meta, index, and load", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "ctx-explicit",
      state: {
        title: "tagged",
        provider: "p",
        model: "m",
        sessionContext: { project: "proc", ticket: "TK-9" },
        updatedAt: "2026-06-10T00:00:00.000Z",
        messages: []
      }
    });
    const paths = getSessionPaths({ homeDir, sessionId: "ctx-explicit" });
    const meta = JSON.parse(await readFile(paths.metaPath, "utf8"));
    expect(meta.sessionContext).toEqual({ project: "proc", ticket: "TK-9" });

    const loaded = await loadSessionState({ homeDir, sessionId: "ctx-explicit" });
    expect(loaded.sessionContext).toEqual({ project: "proc", ticket: "TK-9" });

    const { sessions } = await listSessions({ homeDir, cwd: null });
    expect(sessions[0].sessionContext).toEqual({ project: "proc", ticket: "TK-9" });
  });

  it("derives sessionContext from a worker's procwayMeta when not natively tagged", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "ctx-worker",
      state: {
        title: "runner",
        provider: "p",
        model: "m",
        procwayMeta: { project: "proc", ticket: "TK-1", task: "impl", interactive: false },
        updatedAt: "2026-06-10T00:00:00.000Z",
        messages: []
      }
    });
    const loaded = await loadSessionState({ homeDir, sessionId: "ctx-worker" });
    expect(loaded.sessionContext).toEqual({ project: "proc", ticket: "TK-1" });
  });

  it("leaves plain interactive chats untagged (sessionContext = null)", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "ctx-none",
      state: { title: "chat", provider: "p", model: "m", updatedAt: "2026-06-10T00:00:00.000Z", messages: [] }
    });
    const paths = getSessionPaths({ homeDir, sessionId: "ctx-none" });
    const meta = JSON.parse(await readFile(paths.metaPath, "utf8"));
    // Omitted (not persisted) when there is nothing to tag.
    expect(meta.sessionContext).toBeUndefined();
    const loaded = await loadSessionState({ homeDir, sessionId: "ctx-none" });
    expect(loaded.sessionContext).toBeNull();
  });

  it("keeps sessionContext sticky across saves that omit it", async () => {
    const homeDir = await makeHome();
    await saveSessionState({
      homeDir,
      sessionId: "ctx-sticky",
      state: {
        title: "first",
        provider: "p",
        model: "m",
        sessionContext: { project: "proc", ticket: "TK-2" },
        updatedAt: "2026-06-10T00:00:00.000Z",
        messages: []
      }
    });
    await saveSessionState({
      homeDir,
      sessionId: "ctx-sticky",
      state: { title: "second", provider: "p", model: "m", updatedAt: "2026-06-11T00:00:00.000Z", messages: [] }
    });
    const loaded = await loadSessionState({ homeDir, sessionId: "ctx-sticky" });
    expect(loaded.sessionContext).toEqual({ project: "proc", ticket: "TK-2" });
  });
});

describe("session store — project/ticket filtering (Phase 0)", () => {
  async function seedTaggedSessions(homeDir) {
    await saveSessionState({
      homeDir,
      sessionId: "a-proc-tk1",
      state: { title: "a", provider: "p", model: "m", sessionContext: { project: "proc", ticket: "TK-1" }, updatedAt: "2026-06-03T00:00:00.000Z", messages: [] }
    });
    await saveSessionState({
      homeDir,
      sessionId: "b-proc-tk2",
      state: { title: "b", provider: "p", model: "m", sessionContext: { project: "proc", ticket: "TK-2" }, updatedAt: "2026-06-02T00:00:00.000Z", messages: [] }
    });
    await saveSessionState({
      homeDir,
      sessionId: "c-other-tk1",
      state: { title: "c", provider: "p", model: "m", sessionContext: { project: "other", ticket: "TK-1" }, updatedAt: "2026-06-01T00:00:00.000Z", messages: [] }
    });
    // Untagged chat — must survive an absent filter, drop under a real one.
    await saveSessionState({
      homeDir,
      sessionId: "d-untagged",
      state: { title: "d", provider: "p", model: "m", updatedAt: "2026-06-04T00:00:00.000Z", messages: [] }
    });
  }

  it("no filter lists every session including untagged ones", async () => {
    const homeDir = await makeHome();
    await seedTaggedSessions(homeDir);
    const { sessions } = await listSessions({ homeDir, cwd: null });
    expect(sessions.map((s) => s.sessionId)).toEqual(["d-untagged", "a-proc-tk1", "b-proc-tk2", "c-other-tk1"]);
  });

  it("project filter keeps only matching tagged sessions (untagged excluded)", async () => {
    const homeDir = await makeHome();
    await seedTaggedSessions(homeDir);
    const { sessions } = await listSessions({ homeDir, cwd: null, project: "proc" });
    expect(sessions.map((s) => s.sessionId)).toEqual(["a-proc-tk1", "b-proc-tk2"]);
  });

  it("ticket filter matches exactly; project + ticket AND together", async () => {
    const homeDir = await makeHome();
    await seedTaggedSessions(homeDir);
    const byTicket = await listSessions({ homeDir, cwd: null, ticket: "TK-1" });
    expect(byTicket.sessions.map((s) => s.sessionId)).toEqual(["a-proc-tk1", "c-other-tk1"]);
    const both = await listSessions({ homeDir, cwd: null, project: "proc", ticket: "TK-1" });
    expect(both.sessions.map((s) => s.sessionId)).toEqual(["a-proc-tk1"]);
  });

  it("applies the project filter before pagination so cursors stay stable", async () => {
    const homeDir = await makeHome();
    for (let i = 0; i < 5; i += 1) {
      await saveSessionState({
        homeDir,
        sessionId: `p-${i}`,
        state: { title: `p${i}`, provider: "p", model: "m", sessionContext: { project: "proc" }, updatedAt: `2026-06-0${i + 1}T00:00:00.000Z`, messages: [] }
      });
      await saveSessionState({
        homeDir,
        sessionId: `o-${i}`,
        state: { title: `o${i}`, provider: "p", model: "m", sessionContext: { project: "other" }, updatedAt: `2026-06-0${i + 1}T12:00:00.000Z`, messages: [] }
      });
    }
    const first = await listSessions({ homeDir, cwd: null, project: "proc", limit: 3 });
    expect(first.sessions.map((s) => s.sessionId)).toEqual(["p-4", "p-3", "p-2"]);
    const second = await listSessions({ homeDir, cwd: null, project: "proc", limit: 3, cursor: first.nextCursor });
    expect(second.sessions.map((s) => s.sessionId)).toEqual(["p-1", "p-0"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("session store — meta.createdAt persistence (TK-126)", () => {
  it("writes createdAt on the first save and preserves it across subsequent saves", async () => {
    const homeDir = await makeHome();
    const workspace = "/proj/sticky";
    const sessionId = "sticky";
    await saveSessionState({
      homeDir,
      sessionId,
      state: {
        title: "first",
        provider: "p",
        model: "m",
        cwd: workspace,
        updatedAt: "2026-04-01T00:00:00.000Z",
        messages: []
      }
    });
    const paths = getSessionPaths({ homeDir, sessionId });
    const meta1 = JSON.parse(await readFile(paths.metaPath, "utf8"));
    expect(meta1.createdAt).toBe("2026-04-01T00:00:00.000Z");
    expect(meta1.cwd).toBe(path.resolve(workspace));

    await saveSessionState({
      homeDir,
      sessionId,
      state: {
        title: "second",
        provider: "p",
        model: "m",
        cwd: workspace,
        updatedAt: "2026-04-15T00:00:00.000Z",
        messages: []
      }
    });
    const meta2 = JSON.parse(await readFile(paths.metaPath, "utf8"));
    expect(meta2.createdAt).toBe("2026-04-01T00:00:00.000Z");
    expect(meta2.updatedAt).toBe("2026-04-15T00:00:00.000Z");
  });
});
