import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession } from "../../core/index.mjs";
import { loadSessionState } from "../../session/store.mjs";
import { compareTokens, extractTokenFromUrl, readAuthToken } from "./auth.mjs";
import { attachBridge } from "./bridge.mjs";
import { WsConnection, buildHandshakeResponse } from "./ws-server.mjs";

const PUBLIC_HOSTS = new Set(["0.0.0.0", "::", "::0"]);

const STATIC_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
});

/**
 * Boot the WebSocket bridge server. Returns a control handle exposing the
 * resolved port and a `close()` for graceful shutdown.
 *
 * @param {{
 *   cwd: string,
 *   settings: object,
 *   port?: number,
 *   host?: string,
 *   token?: string | null,
 *   webRoot?: string,
 *   onWarn?: (message: string) => void,
 *   onLog?: (message: string) => void,
 *   sessionFactory?: (input: object) => Promise<any>,
 *   version?: string
 * }} input
 */
export async function startServer({
  cwd,
  settings,
  port = 7777,
  host = "127.0.0.1",
  token = null,
  webRoot = defaultWebRoot(),
  onWarn = null,
  onLog = null,
  sessionFactory = defaultSessionFactory,
  version = "0.1.0-alpha.1"
} = {}) {
  const authToken = token ?? readAuthToken();
  if (!authToken) {
    throw new Error("PROCWAY_SERVE_TOKEN is required (export it before starting `procway-code serve`).");
  }
  if (PUBLIC_HOSTS.has(host) && typeof onWarn === "function") {
    onWarn(`Bound to ${host} — exposing to LAN. Use 127.0.0.1 unless you intend external access.`);
  }

  const handles = new Set();
  // In-memory cache of live AgentSessions keyed by sessionId. When a WS
  // connects with `?resume=<id>` and the matching session is still in memory
  // (e.g. an in-flight turn is running and the page was reloaded), we reuse
  // that instance so events and abort() reach the running turn instead of
  // creating an orphan. Without this, the new WS gets a fresh session and the
  // user has no way to stop the runaway turn.
  const liveSessions = new Map();
  const cachingFactory = async (input) => {
    const sid = input?.sessionId;
    if (sid && liveSessions.has(sid)) return liveSessions.get(sid);
    const session = await sessionFactory(input);
    if (session?.sessionId) {
      liveSessions.set(session.sessionId, session);
      // Drop the cache entry when the session emits its terminal event so
      // listing-from-disk sees fresh state next time.
      const cleanup = () => {
        if (liveSessions.get(session.sessionId) === session) {
          liveSessions.delete(session.sessionId);
        }
      };
      try { session.events?.once?.("session.closed", cleanup); } catch { /* ignore */ }
    }
    return session;
  };

  const server = http.createServer(async (req, res) => {
    try {
      await serveStatic({ req, res, webRoot });
    } catch (error) {
      respondError(res, 500, error?.message ?? "internal error");
    }
  });

  server.on("upgrade", (req, socket, head) => {
    if (head && head.length > 0) socket.unshift(head);
    handleUpgrade({
      req,
      socket,
      authToken,
      cwd,
      settings,
      sessionFactory: cachingFactory,
      version,
      onLog,
      handles
    }).catch((error) => {
      try {
        const message = error?.message ?? "upgrade failed";
        socket.write(`HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`);
      } catch {
        // ignore
      }
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  if (typeof onLog === "function") {
    onLog(`procway-code serve listening on http://${host}:${resolvedPort}`);
  }

  return {
    server,
    host,
    port: resolvedPort,
    async close() {
      for (const handle of handles) {
        try { handle.detach && (await handle.detach()); } catch { /* ignore */ }
        try { handle.ws && handle.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
      }
      handles.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

/**
 * Default session factory: creates a fresh `AgentSession` when called without
 * `sessionId`, or loads the persisted state and rehydrates the session when a
 * `sessionId` is supplied. Throws `Error("No session found: <id>")` when the
 * persisted state is missing — the bridge maps that to `session_not_found`.
 *
 * Messages from the snapshot are passed through to the constructor so callers
 * with `session.enabled: false` (no on-disk replay) still see the persisted
 * state. When `session.enabled` is on, `AgentSession.initialize()` re-reads
 * the snapshot *and* replays any trailing events.jsonl entries past the
 * snapshot's `eventCount` — so a mid-turn crash (where the prompt landed in
 * events.jsonl but the snapshot still only has the system message) recovers
 * the full transcript instead of rendering a blank chat panel.
 */
async function defaultSessionFactory({ settings, cwd, sessionId, origin = null, allowCreateWithId = false, hearingReturnMode = false } = {}) {
  // serve-hosted sessions (chat / Slack) have a UIR surface that can answer a
  // request_user_action — enable the interaction requester (see conversation.mjs).
  // §6: run-loop workers connect with ?hearingMode=return so request_user_action
  // records-and-returns instead of blocking the worker turn.
  if (!sessionId) {
    return createAgentSession({ settings, cwd, origin, interactive: true, hearingReturnMode });
  }
  let state;
  try {
    state = await loadSessionState({ sessionId });
  } catch (error) {
    // ADR 0020: `?session=<id>` is create-or-resume. A missing session is the
    // CREATE case — adopt the caller-chosen id so the dashboard's conversation
    // id and the on-disk AgentSession id stay identical (the per-conversation
    // pod name is derived from this id). Any other load failure (corrupt
    // state, IO error) still propagates so the bridge's fallback handles it.
    if (allowCreateWithId && /^No session found/.test(error?.message ?? "")) {
      return createAgentSession({ settings, cwd, sessionId, origin, interactive: true, hearingReturnMode });
    }
    throw error;
  }
  return createAgentSession({
    settings,
    cwd,
    sessionId,
    interactive: true,
    // §6: a resumed run-loop worker (run loop resume) reconnects with
    // ?hearingMode=return so a SUBSEQUENT hearing in the same session pauses
    // again instead of blocking.
    hearingReturnMode,
    messages: state.messages ?? [],
    title: state.title,
    // A+B: rehydrate procway worker enforcement state across resume so the
    // dashboard restart / ChatPanel takeover keeps nudging for task complete.
    procwayMeta: state.procwayMeta ?? null,
    // The persisted origin wins on resume: a ChatPanel viewer attaching to a
    // worker session (?resume without ?origin) must not relabel it as a user
    // session — the history filter relies on the tag set at creation time.
    origin: state.origin ?? origin,
    pendingTaskCompletionReminder: Boolean(state.pendingTaskCompletionReminder)
  });
}

async function handleUpgrade({ req, socket, authToken, cwd, settings, sessionFactory, version, onLog, handles }) {
  const upgrade = (req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = req.url ?? "/";
  const parsed = (() => { try { return new URL(url, `http://${req.headers.host ?? "localhost"}`); } catch { return null; } })();
  if (!parsed || parsed.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const provided = extractTokenFromUrl(url, req.headers.host ?? "localhost");
  if (!provided || !compareTokens(authToken, provided)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.length === 0) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  // Optional `?resume=<sessionId>` lets the client resume an existing
  // session at handshake time instead of creating a fresh one and then
  // calling `loadSession` (which leaves the discarded fresh session on
  // disk and clutters listSessions). When resume is missing or malformed
  // we fall back to the original "create new session" path.
  const resumeId = (() => {
    const raw = parsed.searchParams.get("resume");
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  })();
  // Optional `?session=<id>` (ADR 0020): create-or-resume with a CALLER-chosen
  // id — resume when the session exists on disk, otherwise create a fresh
  // session that ADOPTS this exact id. The dashboard derives the
  // per-conversation pod name from the conversation id, so the on-disk
  // AgentSession id must match what the dashboard minted. Unlike `?resume=`
  // (arbitrary historical ids), this id becomes a DIRECTORY NAME on first use,
  // so it is restricted to a safe token (no path separators / traversal).
  const explicitSessionId = (() => {
    const raw = parsed.searchParams.get("session");
    if (typeof raw !== "string" || raw.length === 0) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(raw)) return null;
    return raw;
  })();
  // Optional `?cwd=<absolute-path>` overrides the serve-level cwd for this
  // connection's session. Phase 4a of runner-hardening-and-interactive-
  // hearing-plan: ticket workers need to run their tools against the
  // worktree (e.g. `D:\…\backlogs\TK-139\code\procway`), but the serve
  // process is launched with a single fixed cwd (the dashboard repo).
  // Per-connection cwd lets one serve process service both the AI chat
  // (default cwd) and per-ticket worker sessions (worktree cwd) without
  // booting a fresh serve per ticket.
  const sessionCwd = (() => {
    const raw = parsed.searchParams.get("cwd");
    if (typeof raw !== "string" || raw.length === 0) return null;
    // Reject obviously malformed values; we don't sandbox harder because
    // serve is already token-gated and localhost-bound by default.
    if (raw.includes("\0")) return null;
    if (!path.isAbsolute(raw)) return null;
    return path.resolve(raw);
  })();
  const effectiveCwd = sessionCwd ?? cwd;
  // Optional `?origin=<tag>` labels the session at creation time (persisted
  // in meta.json/index.json). Programmatic workers (serve-client.mjs
  // runServeWorker — runner / check agent / re-review / process design) send
  // `origin=worker`; browser ChatPanel handshakes send nothing, so user
  // sessions stay origin-less. listSessions({ origin: "user" }) filters on
  // this tag to keep worker noise out of the /ai history sidebar.
  const sessionOrigin = (() => {
    const raw = parsed.searchParams.get("origin");
    if (typeof raw !== "string" || raw.length === 0) return null;
    // Keep the tag a simple token — it round-trips through JSON metadata.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return null;
    return raw;
  })();
  // §6: `?hearingMode=return` marks a run-loop worker connection whose
  // request_user_action must record-and-return (non-blocking) instead of
  // blocking the worker turn. Anything else (absent / "block") keeps the
  // blocking behaviour used by AI chat + Slack sessions.
  const hearingReturnMode = parsed.searchParams.get("hearingMode") === "return";
  socket.write(buildHandshakeResponse(key));
  const ws = new WsConnection(socket);
  // Buffer client frames that land between the 101 handshake and the bridge
  // attach below. WsConnection starts parsing socket data immediately, but
  // the bridge's `message` handler is only registered AFTER the (async)
  // sessionFactory call — and EventEmitter does not queue emits with no
  // listener, so a command sent right after the client's `open` (before the
  // `{kind:"ready"}` frame) was silently DROPPED: no response, no error, a
  // near-undebuggable hang. All shipped clients happen to wait for `ready`
  // (useProcwayCodeClient / serve-client), so this is robustness for the next
  // client that doesn't. Replayed in arrival order once the bridge attaches.
  const preAttachBacklog = [];
  const bufferPreAttach = (text) => { preAttachBacklog.push(text); };
  ws.on("message", bufferPreAttach);
  // `?session=` (create-or-resume) wins over `?resume=` when both are sent.
  const requestedId = explicitSessionId ?? resumeId;
  let session;
  try {
    session = await sessionFactory({
      settings,
      cwd: effectiveCwd,
      sessionId: requestedId ?? undefined,
      origin: sessionOrigin,
      allowCreateWithId: explicitSessionId != null,
      hearingReturnMode
    });
  } catch (error) {
    // A resume that targets a session which no longer exists must NOT be fatal:
    // the session store is reset whenever the container restarts (the SaaS
    // session Pod's .procway is ephemeral), and clients cache the last session
    // id, so after any restart the client reconnects with `?resume=<gone-id>`.
    // Failing hard here closed the socket 1011 "session start failed", the
    // client retried the SAME resume up to its cap, and the chat got stuck
    // ("接続が切れ、自動再接続も失敗"). Fall back to a FRESH session so the user
    // keeps working; only a fresh-session failure (requestedId was null) is
    // fatal. A `?session=` create-or-resume only lands here on a non-missing
    // load failure (corrupt state) — same fallback applies, at the cost of the
    // fresh session minting its own id instead of the requested one.
    if (requestedId) {
      try {
        session = await sessionFactory({ settings, cwd: effectiveCwd, sessionId: undefined, origin: sessionOrigin, hearingReturnMode });
        onLog?.(`resume "${requestedId}" failed (${error?.message ?? "unknown"}); started a fresh session`);
      } catch (freshError) {
        ws.send(JSON.stringify({ kind: "error", error: freshError?.message ?? "session start failed", fatal: true }));
        ws.close(1011, "session start failed");
        return;
      }
    } else {
      ws.send(JSON.stringify({ kind: "error", error: error?.message ?? "session start failed", fatal: true }));
      ws.close(1011, "session start failed");
      return;
    }
  }
  // Bridge hygiene on resume/reconnect. A resume onto a session that is still
  // live-cached (cachingFactory returns the SAME instance, server.mjs:67-69)
  // attaches an additional `*` event forwarder onto the one EventBus.
  //
  //   - Handles whose socket already CLOSED (page reload mid-turn, in-pane
  //     re-handshake) are reaped here: their close-wired detach is
  //     fire-and-forget and may not have run yet, and leaving them around
  //     accumulates dead forwarders on the bus.
  //   - Handles whose socket is still OPEN are KEPT. The runner that created
  //     the session (serve-client.mjs runServeWorker) holds its WS for the
  //     whole turn, and the ChatPanel viewer attaches with `?resume` mid-turn
  //     to render live progress (Phase 4b). The previous unconditional kick
  //     ("superseded by a newer connection") killed every dashboard Run ~2s in:
  //     the RunnerPanel's status poll discovered the run, the viewer attached,
  //     and the worker's WS died before turn.completed.
  //
  // Concurrent forwarders are safe: bridge.mjs wraps every forwarder send in
  // try/catch, so one failing peer can never block fan-out to the others.
  for (const h of [...handles]) {
    if (h.session === session || (h.session?.sessionId && h.session.sessionId === session.sessionId)) {
      if (h.ws && h.ws.closed !== true) continue; // live peer (worker driver / viewer) — coexist
      handles.delete(h);
      try { await h.detach(); } catch { /* best-effort: stale bridge teardown */ }
      // Close the reaped socket handle too (no-op when already fully closed);
      // leaving it half-connected would block a graceful server shutdown.
      try { h.ws?.close?.(1000, "superseded by a newer connection"); } catch { /* already closing */ }
    }
  }
  const bridge = attachBridge({ session, ws, cwd: effectiveCwd, settings, sessionFactory, version, logger: onLog });
  // Bridge handler is live — stop buffering and replay anything that arrived
  // during session creation (synchronous swap: no frame can land in between).
  ws.off("message", bufferPreAttach);
  for (const text of preAttachBacklog) {
    ws.emit("message", text);
  }
  preAttachBacklog.length = 0;
  const handle = { ws, session, detach: bridge.detach };
  handles.add(handle);
  ws.on("close", () => handles.delete(handle));
  // TK-131 defense in depth: even though ws-server.mjs only re-emits 'error'
  // when listeners exist, register a logger here so socket-level errors
  // (ECONNRESET on browser close, EPIPE on half-open writes) are observable
  // rather than swallowed silently.
  ws.on("error", (error) => {
    if (typeof onLog === "function") {
      try {
        onLog({ level: "warn", message: "ws connection error", error: error?.message ?? String(error) });
      } catch { /* logger failure is non-fatal */ }
    }
  });
}

async function serveStatic({ req, res, webRoot }) {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    respondError(res, 405, "method not allowed");
    return;
  }
  const url = req.url ?? "/";
  const parsed = (() => { try { return new URL(url, `http://${req.headers.host ?? "localhost"}`); } catch { return null; } })();
  let pathname = parsed ? parsed.pathname : "/";
  if (pathname === "/") pathname = "/index.html";
  pathname = pathname.replace(/^\/+/, "/");
  if (pathname.includes("..")) {
    respondError(res, 400, "bad path");
    return;
  }
  const filePath = path.join(webRoot, pathname.slice(1));
  const rel = path.relative(webRoot, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    respondError(res, 400, "bad path");
    return;
  }
  let body;
  try {
    body = await readFile(filePath);
  } catch {
    respondError(res, 404, "not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = STATIC_TYPES[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

function respondError(res, status, message) {
  if (res.headersSent) return;
  const body = `${message}\n`;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function defaultWebRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "web");
}
