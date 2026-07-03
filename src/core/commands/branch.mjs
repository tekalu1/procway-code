import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createEvent } from "../events/types.mjs";
import { getSessionDir, getSessionPaths, saveSessionState } from "../../session/store.mjs";
import { resolveActiveModel } from "../../config/active-model.mjs";

/**
 * `/branch from <messageId>` — create a new session whose history matches
 * the active session up to (and including) the given user message id.
 *
 * Layout:
 *   ~/.procway/ai-agent/sessions/<sessionId>/branches/<branchId>/branch.json
 *
 * The original session's events.jsonl is left untouched. The branch session
 * receives a fresh sessionId so existing tooling (`listSessions`, replay)
 * continues to work.
 *
 * @param {{ session: { sessionId: string, cwd: string, messages: Array<{ id: string, role: string }>, settings: object, title?: string, eventCount?: number, encryptionKey?: any }, args?: string[] | { fromMessageId?: string }, branchId?: string }} input
 */
export async function branchCommand({ session, args = [], branchId = randomUUID() } = {}) {
  if (!session) throw new TypeError("branchCommand: session is required");
  const fromMessageId = parseFromMessageId(args);
  if (!fromMessageId) {
    return {
      sessionId: session.sessionId,
      ok: false,
      error: "missing fromMessageId",
      hint: "Usage: /branch from <messageId>"
    };
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const idx = messages.findIndex((message) => message?.id === fromMessageId);
  if (idx === -1) {
    return {
      sessionId: session.sessionId,
      ok: false,
      error: "messageId not found",
      fromMessageId
    };
  }
  const head = messages.slice(0, idx + 1);

  const homeDir = session.homeDir ?? os.homedir();
  const branchSessionId = `${session.sessionId}-branch-${branchId.slice(0, 8)}`;
  const branchDir = path.join(getSessionDir({ homeDir, sessionId: session.sessionId }), "branches", branchId);
  await mkdir(branchDir, { recursive: true });

  // The branch is also registered in the regular session index so that
  // /resume / listSessions can pick it up. We persist the branch slice as
  // a fresh session under ~/.procway/ai-agent/sessions/<branchSessionId>/.
  await saveSessionState({
    homeDir,
    sessionId: branchSessionId,
    state: {
      sessionId: branchSessionId,
      title: session.title ?? null,
      cwd: session.cwd,
      provider: session.settings?.defaultProvider ?? null,
      model: resolveActiveModel(session.settings),
      updatedAt: new Date().toISOString(),
      eventCount: 0,
      messages: head
    },
    encryptionKey: session.encryptionKey ?? null
  });

  // Drop a marker in the parent session so the relationship is auditable on disk.
  const markerPath = path.join(branchDir, "branch.json");
  if (!existsSync(markerPath)) {
    await writeFile(markerPath, JSON.stringify({
      branchId,
      branchSessionId,
      fromSessionId: session.sessionId,
      fromMessageId,
      headLength: head.length,
      createdAt: new Date().toISOString()
    }, null, 2) + "\n", "utf8");
  }

  session.events?.emit?.(createEvent("session.branched", {
    sessionId: session.sessionId,
    fromSessionId: session.sessionId,
    fromMessageId,
    toSessionId: branchSessionId
  }));

  // Surface the parent's events.jsonl path so tooling can confirm we did not
  // touch it (returned for tests + report).
  const { eventsPath: parentEvents } = getSessionPaths({ homeDir, sessionId: session.sessionId });
  return {
    sessionId: session.sessionId,
    ok: true,
    branchId,
    branchSessionId,
    fromMessageId,
    branchDir,
    parentEventsPath: parentEvents
  };
}

function parseFromMessageId(args) {
  if (Array.isArray(args)) {
    if (args[0] === "from" && typeof args[1] === "string") return args[1];
    if (typeof args[0] === "string" && args[0].length > 0) return args[0];
    return null;
  }
  if (args && typeof args === "object") {
    return args.fromMessageId ?? null;
  }
  return null;
}
