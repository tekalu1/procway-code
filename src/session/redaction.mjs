/**
 * Phase 6 §2.7 — secret masking for event-log writes.
 *
 * `redact(text, options)` and `redactEvent(event, options)` apply a list of
 * regex patterns and replace each match with `[REDACTED]`. The patterns run
 * AFTER the in-memory event is captured, so providers continue to see the
 * raw payload — only the on-disk event-log / snapshot is redacted.
 *
 * Default patterns target widely-leaked credentials (AWS, OpenAI / OpenRouter,
 * GitHub, generic Bearer). User patterns from `settings.session.redaction`
 * (literal RegExp objects or `{ pattern, flags }` records) are appended.
 */

const REDACTION_PLACEHOLDER = "[REDACTED]";

export const DEFAULT_REDACTION_PATTERNS = Object.freeze([
  /AKIA[0-9A-Z]{16}/g,
  /sk-or-v1-[A-Za-z0-9_-]{40,}/g,
  /sk-[A-Za-z0-9_-]{40,}/g,
  /(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi
]);

export function redact(text, { patterns = DEFAULT_REDACTION_PATTERNS } = {}) {
  if (typeof text !== "string" || text.length === 0) return text;
  let output = text;
  for (const pattern of patterns) {
    const regex = toRegExp(pattern);
    if (!regex) continue;
    output = output.replace(regex, REDACTION_PLACEHOLDER);
  }
  return output;
}

export function redactEvent(event, options = {}) {
  if (event == null) return event;
  if (typeof event === "string") return redact(event, options);
  if (Array.isArray(event)) return event.map((entry) => redactEvent(entry, options));
  if (typeof event === "object") {
    const out = Array.isArray(event) ? [] : {};
    for (const [key, value] of Object.entries(event)) {
      out[key] = redactEvent(value, options);
    }
    return out;
  }
  return event;
}

export function combinePatterns(extraPatterns = []) {
  const list = [...DEFAULT_REDACTION_PATTERNS];
  for (const entry of extraPatterns) {
    const regex = toRegExp(entry);
    if (regex) list.push(regex);
  }
  return list;
}

function toRegExp(value) {
  if (value instanceof RegExp) return ensureGlobal(value);
  if (typeof value === "string") {
    try {
      return new RegExp(value, "g");
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && typeof value.pattern === "string") {
    try {
      const flags = typeof value.flags === "string" && value.flags.length > 0
        ? (value.flags.includes("g") ? value.flags : `${value.flags}g`)
        : "g";
      return new RegExp(value.pattern, flags);
    } catch {
      return null;
    }
  }
  return null;
}

function ensureGlobal(regex) {
  if (regex.flags.includes("g")) return regex;
  return new RegExp(regex.source, `${regex.flags}g`);
}
