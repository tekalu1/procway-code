/**
 * WebSocket bridge protocol shapes.
 *
 * The bridge speaks five top-level message kinds:
 *   - "ready"    server → client, sent immediately after upgrade
 *   - "event"    server → client, broadcast of every AgentSession event
 *   - "command"  client → server, request to invoke a session method
 *   - "response" server → client, reply to a previous command
 *   - "error"    server → client, fatal or non-fatal error notification
 */

export const SERVER_KINDS = Object.freeze(["ready", "event", "response", "error"]);
export const CLIENT_KINDS = Object.freeze(["command"]);

/**
 * Serve-protocol version, negotiated via the `ready` frame (ADR 0030 D4).
 * Independent of the package version (`version` on `ready` stays the package
 * version, informational only). Compat policy: backward-compatible additions
 * (new commands, new fields on existing messages) keep this number; breaking
 * changes (message shapes, semantics of existing COMMANDS) bump it. Hosts
 * treat a `ready` without `protocolVersion` (pre-ADR-0030 agents) as 1.
 */
export const PROTOCOL_VERSION = 1;

export const COMMANDS = Object.freeze([
  "runTurn",
  "approve",
  "interaction.resolve",
  "compact",
  "history",
  "abort",
  "listSessions",
  "loadSession"
]);

export function isServerMessage(value) {
  return value && typeof value === "object" && SERVER_KINDS.includes(value.kind);
}

export function isClientMessage(value) {
  return value && typeof value === "object" && CLIENT_KINDS.includes(value.kind);
}

export function makeReady({ sessionId, version }) {
  return { kind: "ready", sessionId, version, protocolVersion: PROTOCOL_VERSION };
}

export function makeEvent(event) {
  return { kind: "event", event };
}

/**
 * Build a `{kind:"response"}` frame. `error` may be a string (legacy commands)
 * or a structured `{code, message}` object — the latter is required by the
 * listSessions / loadSession dispatch (TK-126).
 */
export function makeResponse({ id, ok, result, error }) {
  if (ok) return { kind: "response", id, ok: true, result: result ?? null };
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return { kind: "response", id, ok: false, error };
  }
  return { kind: "response", id, ok: false, error: String(error ?? "unknown") };
}

export function makeErrorMessage({ error, fatal = false }) {
  return { kind: "error", error: String(error ?? "unknown"), fatal: fatal === true };
}

/**
 * Parse a Buffer or string into a client message. Returns null when the
 * payload is not valid JSON or the shape is unrecognised.
 *
 * @param {Buffer | string} raw
 * @returns {{ kind: "command", command: string, id?: string, args?: object } | null}
 */
export function parseClientMessage(raw) {
  let text;
  if (typeof raw === "string") text = raw;
  else if (raw && typeof raw.toString === "function") text = raw.toString("utf8");
  else return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || value.kind !== "command") return null;
  if (typeof value.command !== "string" || !COMMANDS.includes(value.command)) return null;
  return value;
}

/**
 * Validate `listSessions` args. `args` may be undefined; otherwise `limit` must
 * be an integer in [1, 200] and `cursor` must be a string. Throws with a
 * message that includes the offending field name.
 */
export function validateListSessionsArgs(args) {
  if (args === undefined || args === null) return;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error("listSessions: args must be an object");
  }
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) {
      throw new Error("listSessions: limit must be an integer in [1, 200]");
    }
  }
  if (args.cursor !== undefined && args.cursor !== null) {
    if (typeof args.cursor !== "string") {
      throw new Error("listSessions: cursor must be a string");
    }
  }
}

/** Max attachments accepted on a single runTurn. */
export const MAX_RUNTURN_ATTACHMENTS = 16;

/**
 * Validate + normalize `runTurn` attachments. Returns a clean
 * `[{ id, mime?, name? }]` array (empty when none). Throws with the offending
 * index on bad shape. `id` is a dashboard attachment id; the bytes are
 * fetched over HTTP in the provider hydration layer (the single attachment
 * transport — sessions never read attachment blobs off a shared volume),
 * so this only checks shape. `name` is the original client filename, used
 * only for the attachment note in the user message (save_attachment UX).
 */
export function normalizeRunTurnAttachments(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    throw new Error("runTurn: attachments must be an array");
  }
  if (attachments.length > MAX_RUNTURN_ATTACHMENTS) {
    throw new Error(`runTurn: too many attachments (max ${MAX_RUNTURN_ATTACHMENTS})`);
  }
  return attachments.map((a, i) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      throw new Error(`runTurn: attachment[${i}] must be an object`);
    }
    if (typeof a.id !== "string" || a.id.length === 0) {
      throw new Error(`runTurn: attachment[${i}].id is required`);
    }
    const normalized = { id: a.id };
    if (a.mime !== undefined) {
      if (typeof a.mime !== "string") throw new Error(`runTurn: attachment[${i}].mime must be a string`);
      normalized.mime = a.mime;
    }
    if (a.name !== undefined && a.name !== null) {
      if (typeof a.name !== "string") throw new Error(`runTurn: attachment[${i}].name must be a string`);
      const name = a.name.trim().slice(0, 255);
      if (name) normalized.name = name;
    }
    return normalized;
  });
}

/**
 * Validate `loadSession` args. `args.sessionId` must be a non-empty string.
 * Throws with a message that includes the offending field name.
 */
export function validateLoadSessionArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("loadSession: sessionId is required");
  }
  if (typeof args.sessionId !== "string" || args.sessionId.length === 0) {
    throw new Error("loadSession: sessionId is required");
  }
}
