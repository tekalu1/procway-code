// Regression tests for the serve single-bridge-per-session guarantee and the
// resume-fallback behavior in src/adapters/serve/server.mjs handleUpgrade.
//
// These cover a fix that is easy to regress: when a SECOND WebSocket resumes a
// session that is still live in the serve's in-memory cache (page reload mid-
// turn, in-pane re-handshake), the server must detach the PRIOR bridge before
// attaching the new one, so the session's EventBus has exactly one `*`
// forwarder. Otherwise turn.completed fans out to a stale/closed socket and the
// live UI never receives it → the chat hangs at "model waiting" forever.
//
// We inject a sessionFactory returning a controlled fake session with a real
// EventBus, so we can emit events and assert exactly which socket receives them
// — no LLM/process needed.
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events/bus.mjs";
import { createEvent } from "../src/core/events/types.mjs";
import { startServer } from "../src/adapters/serve/server.mjs";
import { connect, waitFor, collectMessages } from "./helpers/ws-client.mjs";

const TOKEN = "good-token";

/** Count of wildcard ("*") forwarders on a session's EventBus (no public
 *  listenerCount; the bridge registers exactly one per attach). */
function wildcardForwarders(session) {
  return session.events.handlers.get("*")?.size ?? 0;
}

/** Minimal session the bridge can attach to: events (EventBus), sessionId,
 *  empty messages (no resume replay), best-effort flushEventLog. */
function makeFakeSession(sessionId) {
  return {
    sessionId,
    events: new EventBus(),
    messages: [],
    flushEventLog: async () => {},
  };
}

/** Receive the next turn.completed on a raw connect() emitter (true) or false
 *  if none arrives within `ms`. Uses a plain listener so a NON-arrival is a
 *  pass (collectMessages would reject on timeout). */
function sawTurnCompleted(ws, ms) {
  return new Promise((resolve) => {
    let done = false;
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m?.kind === "event" && m.event?.type === "turn.completed") {
          if (!done) { done = true; ws.off("message", onMsg); resolve(true); }
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.on("message", onMsg);
    setTimeout(() => { if (!done) { done = true; ws.off("message", onMsg); resolve(false); } }, ms);
  });
}

describe("serve — single bridge per session + resume fallback", () => {
  let handle;
  afterEach(async () => {
    if (handle?.close) await handle.close();
    handle = null;
  });

  it("a LIVE peer coexists with a resume attach: turn.completed reaches BOTH sockets (worker driver + viewer)", async () => {
    const session = makeFakeSession("sess-live-1");
    handle = await startServer({
      cwd: process.cwd(),
      settings: {},
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      // Always hand back the SAME instance; cachingFactory caches it by
      // sessionId so the resume below reuses the live session.
      sessionFactory: async () => session,
    });

    // Socket A: fresh connect → creates+caches the session, bridge A attaches.
    // This is the worker driver (runServeWorker) holding its WS for the turn.
    const wsA = connect({ host: "127.0.0.1", port: handle.port, token: TOKEN });
    const wsAReady = collectMessages(wsA, (m) => m && m.kind === "ready"); // attach BEFORE any await
    await waitFor(wsA, "open");
    await wsAReady;
    expect(wildcardForwarders(session)).toBe(1); // exactly bridge A

    // Socket B: a ChatPanel viewer resuming the same live session mid-turn.
    // A is still OPEN, so it must be KEPT — kicking it killed every dashboard
    // Run ~2s in ("superseded by a newer connection") once the RunnerPanel
    // poll discovered the run and auto-attached the viewer.
    const wsB = connect({ host: "127.0.0.1", port: handle.port, token: TOKEN, query: { resume: "sess-live-1" } });
    const wsBReady = collectMessages(wsB, (m) => m && m.kind === "ready");
    await waitFor(wsB, "open");
    await wsBReady;
    expect(wildcardForwarders(session)).toBe(2); // A (driver) + B (viewer)

    // Arm receivers BEFORE emitting (TCP delivery is async).
    const bGot = sawTurnCompleted(wsB, 2000);
    const aGot = sawTurnCompleted(wsA, 2000);
    session.events.emit(createEvent("turn.completed", { round: 0, exitCode: 0 }));

    expect(await bGot).toBe(true); // viewer receives it
    expect(await aGot).toBe(true); // driver ALSO receives it — its run finalizes

    wsA.close();
    wsB.close();
  });

  it("a CLOSED peer's bridge is reaped on the next resume attach (stale-socket hygiene)", async () => {
    const session = makeFakeSession("sess-live-2");
    handle = await startServer({
      cwd: process.cwd(),
      settings: {},
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      sessionFactory: async () => session,
    });

    // Socket A connects, then the client goes away abruptly (page reload
    // mid-turn → ECONNRESET, the TK-131 hook). Wait until the server has
    // observed the close: the bridge's close-wired detach drops A's forwarder.
    const wsA = connect({ host: "127.0.0.1", port: handle.port, token: TOKEN });
    const wsAReady = collectMessages(wsA, (m) => m && m.kind === "ready");
    await waitFor(wsA, "open");
    await wsAReady;
    wsA.socket.destroy();
    const deadline = Date.now() + 2000;
    while (wildcardForwarders(session) > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(wildcardForwarders(session)).toBe(0);

    // Socket B resumes: any leftover bridge for A must be gone, exactly one
    // forwarder (B's) remains and receives events.
    const wsB = connect({ host: "127.0.0.1", port: handle.port, token: TOKEN, query: { resume: "sess-live-2" } });
    const wsBReady = collectMessages(wsB, (m) => m && m.kind === "ready");
    await waitFor(wsB, "open");
    await wsBReady;
    expect(wildcardForwarders(session)).toBe(1);

    const bGot = sawTurnCompleted(wsB, 2000);
    session.events.emit(createEvent("turn.completed", { round: 0, exitCode: 0 }));
    expect(await bGot).toBe(true);

    wsB.close();
  });

  it("does NOT detach an unrelated session's bridge (only the matching sessionId is detached)", async () => {
    let n = 0;
    const created = [];
    handle = await startServer({
      cwd: process.cwd(),
      settings: {},
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      // Each fresh (no-resume) connect mints a DISTINCT session.
      sessionFactory: async ({ sessionId }) => {
        const s = makeFakeSession(sessionId ?? `gen-${++n}`);
        created.push(s);
        return s;
      },
    });

    const ws1 = connect({ host: "127.0.0.1", port: handle.port, token: TOKEN });
    const ws1Ready = collectMessages(ws1, (m) => m && m.kind === "ready");
    await waitFor(ws1, "open");
    await ws1Ready;
    const ws2 = connect({ host: "127.0.0.1", port: handle.port, token: TOKEN });
    const ws2Ready = collectMessages(ws2, (m) => m && m.kind === "ready");
    await waitFor(ws2, "open");
    await ws2Ready;

    expect(created).toHaveLength(2); // two independent sessions
    expect(wildcardForwarders(created[0])).toBe(1);
    expect(wildcardForwarders(created[1])).toBe(1);

    // An event on session 1 reaches ws1 only; ws2's bridge is untouched.
    const got1 = sawTurnCompleted(ws1, 2000);
    const got2 = sawTurnCompleted(ws2, 1500);
    created[0].events.emit(createEvent("turn.completed", { round: 0, exitCode: 0 }));
    expect(await got1).toBe(true);
    expect(await got2).toBe(false);

    ws1.close();
    ws2.close();
  });

  it("resume of an unknown/gone session falls back to a FRESH session (ready frame, not fatal 1011)", async () => {
    const calls = [];
    handle = await startServer({
      cwd: process.cwd(),
      settings: {},
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      sessionFactory: async ({ sessionId }) => {
        calls.push(sessionId);
        if (sessionId === "gone") throw new Error("session not found: gone");
        return makeFakeSession(sessionId ?? "fresh");
      },
    });

    const ws = connect({ host: "127.0.0.1", port: handle.port, token: TOKEN, query: { resume: "gone" } });
    const msgsP = collectMessages(ws, (m) => m && (m.kind === "ready" || (m.kind === "error" && m.fatal)));
    await waitFor(ws, "open");
    // Must get a ready frame (fresh fallback), never a fatal error.
    const msgs = await msgsP;
    const ready = msgs.find((x) => x.parsed?.kind === "ready");
    const fatal = msgs.find((x) => x.parsed?.kind === "error" && x.parsed?.fatal);
    expect(ready, "expected a fresh-session ready frame").toBeTruthy();
    expect(fatal).toBeUndefined();
    // Tried the resume id first, then retried fresh (sessionId undefined).
    expect(calls).toEqual(["gone", undefined]);

    ws.close();
  });
});
