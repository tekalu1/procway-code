/**
 * Session-context tag helpers (project/ticket) — the single source of truth for
 * how a `{ project?, ticket? } | null` tag is normalized and derived.
 *
 * Lives in its own module (instead of store.mjs / session-index.mjs) so both
 * the save path (store.mjs) and the index-rebuild path (session-index.mjs) share
 * one implementation without participating in the store ↔ index import cycle.
 *
 * The tag is used solely as a sidebar filter dimension (Phase 0). It is kept
 * separate from `procwayMeta` (worker enforcement state) so it carries no
 * behavioural side-effects.
 */

/**
 * Coerce a stored/derived session-context value into either a clean
 * `{ project?, ticket? }` object (only non-empty string fields kept) or null
 * when there is nothing to tag. Tolerates legacy meta that never had the
 * field (null/undefined) and malformed shapes.
 */
export function normalizeSessionContext(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  if (typeof value.project === "string" && value.project.length > 0) out.project = value.project;
  if (typeof value.ticket === "string" && value.ticket.length > 0) out.ticket = value.ticket;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Derive a session-context tag from a worker session's `procwayMeta` so legacy
 * and runner history get the same project/ticket filter dimension as natively
 * tagged sessions. Returns null for non-worker / untagged metas.
 */
export function deriveSessionContext(procwayMeta) {
  if (!procwayMeta || typeof procwayMeta !== "object") return null;
  return normalizeSessionContext({ project: procwayMeta.project, ticket: procwayMeta.ticket });
}

/**
 * Resolve the session-context tag for a session's persisted meta: the natively
 * persisted `meta.sessionContext` wins, otherwise derive `{ project, ticket }`
 * from the worker's `procwayMeta`. Returns null when there is nothing to tag.
 */
export function resolveSessionContext(meta) {
  if (meta?.sessionContext && typeof meta.sessionContext === "object") {
    return normalizeSessionContext(meta.sessionContext);
  }
  return deriveSessionContext(meta?.procwayMeta ?? null);
}
