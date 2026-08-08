/**
 * Small pure formatters shared by the slash-command renderers (P3b-1).
 *
 * They exist so "3 hours ago", "$0.0123" and "12.3k" are spelled the same way
 * in the session picker, the `/usage` table and the prompt line — a number
 * formatted three different ways in three places is exactly the kind of thing
 * that made the old raw-JSON output feel unfinished.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" / "5 minutes ago" / "3 hours ago" / "2 days ago".
 * Accepts an ISO string, a Date or an epoch-millisecond number; returns "" for
 * anything unparseable so callers can fall back to a placeholder.
 */
export function formatRelativeTime(value, { now = Date.now() } = {}) {
  const when = toEpochMs(value);
  if (when == null) return "";
  const delta = now - when;
  if (!Number.isFinite(delta)) return "";
  if (delta < 0) return "just now";
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), "minute");
  if (delta < DAY) return plural(Math.floor(delta / HOUR), "hour");
  if (delta < 30 * DAY) return plural(Math.floor(delta / DAY), "day");
  const months = Math.floor(delta / (30 * DAY));
  if (months < 12) return plural(months, "month");
  return plural(Math.floor(months / 12), "year");
}

function toEpochMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** Thousands-separated integer; "-" for a missing value. */
export function formatCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString("en-US");
}

/**
 * Compact token counts for the prompt line, where every column matters:
 * 950 → "950", 12 345 → "12.3k", 1 200 000 → "1.2M".
 */
export function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${trimZero((value / 1000).toFixed(1))}k`;
  return `${trimZero((value / 1_000_000).toFixed(1))}M`;
}

function trimZero(text) {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * USD with enough precision to be useful at agent scale: sub-cent amounts keep
 * four decimals, everything else two. `0` renders as "$0.00", not "-", so a
 * zero-cost session is visibly zero rather than unknown.
 */
export function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** "0.4s" / "12s" / "3m 05s" — used by the activity spinner. */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** "812 B" / "12.4 KB" / "3.1 MB". */
export function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${trimZero((value / 1024).toFixed(1))} KB`;
  return `${trimZero((value / (1024 * 1024)).toFixed(1))} MB`;
}
