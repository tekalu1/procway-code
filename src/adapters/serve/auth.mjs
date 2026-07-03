import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of two tokens. Returns false when either input is
 * empty, non-string, or the lengths differ — so callers can treat the result
 * as a single boolean gate without leaking the comparison branch via timing.
 *
 * @param {string} expected
 * @param {string} provided
 * @returns {boolean}
 */
export function compareTokens(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  if (expected.length === 0 || provided.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read the WebSocket bridge auth token from the environment, defaulting to
 * `PROCWAY_SERVE_TOKEN`. Empty / whitespace-only values are rejected so the
 * server cannot accidentally start with a permissive token.
 *
 * @param {{ env?: NodeJS.ProcessEnv, varName?: string }} [opts]
 */
export function readAuthToken({ env = process.env, varName = "PROCWAY_SERVE_TOKEN" } = {}) {
  const value = env?.[varName];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Pull the `token` query-string parameter out of a request URL. Returns null
 * when the URL is malformed or the parameter is absent / empty.
 *
 * @param {string | undefined} requestUrl
 * @param {string} [host]
 */
export function extractTokenFromUrl(requestUrl, host = "localhost") {
  if (typeof requestUrl !== "string" || requestUrl.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(requestUrl, `http://${host}`);
  } catch {
    return null;
  }
  const token = parsed.searchParams.get("token");
  if (typeof token !== "string" || token.length === 0) return null;
  return token;
}
