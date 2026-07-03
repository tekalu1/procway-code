/**
 * @typedef {{
 *   allow?: string[],
 *   deny?:  string[],
 *   ask?:   string[]
 * }} PermissionRules
 */

const READ_ONLY_KINDS = new Set(["read_file", "list_files", "search_files", "web_search", "web_fetch"]);

/**
 * Evaluate permission rules against a tool call.
 *
 * Each rule is one of:
 *  - `<kind>:<pattern>`           — kind-prefixed glob (suffix `*` allowed)
 *  - `/<regex>/`                  — regex applied to `kind:summary`
 *  - exact string                 — equals `kind:summary`
 *
 * Order: deny → allow → ask → default. A `deny` match always wins.
 *
 * @param {{ rules?: PermissionRules, kind: string, summary?: string, mutation?: boolean }} args
 * @returns {"allow" | "deny" | "ask"}
 */
export function evaluatePermissions({ rules, kind, summary = "", mutation = false }) {
  const target = `${kind}:${summary}`;
  const denyList = Array.isArray(rules?.deny) ? rules.deny : [];
  if (denyList.some((rule) => matchRule(rule, kind, summary, target))) return "deny";

  const allowList = Array.isArray(rules?.allow) ? rules.allow : [];
  if (allowList.some((rule) => matchRule(rule, kind, summary, target))) return "allow";

  const askList = Array.isArray(rules?.ask) ? rules.ask : [];
  if (askList.some((rule) => matchRule(rule, kind, summary, target))) return "ask";

  if (mutation === true) return "ask";
  if (READ_ONLY_KINDS.has(kind)) return "allow";
  return "ask";
}

function matchRule(rule, kind, summary, target) {
  if (typeof rule !== "string" || rule.length === 0) return false;
  if (rule.startsWith("/") && rule.endsWith("/") && rule.length >= 2) {
    try {
      return new RegExp(rule.slice(1, -1)).test(target);
    } catch {
      return false;
    }
  }
  const colonIndex = rule.indexOf(":");
  if (colonIndex >= 0) {
    const ruleKind = rule.slice(0, colonIndex);
    const rulePattern = rule.slice(colonIndex + 1);
    if (ruleKind !== kind) return false;
    return matchPattern(rulePattern, summary);
  }
  return rule === target;
}

function matchPattern(pattern, value) {
  if (pattern === "*" || pattern === "") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === pattern;
}
