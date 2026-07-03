import { scanInstructions } from "./instruction-scanner.mjs";
import { scanSkills } from "./skill-scanner.mjs";

export async function resolveContext({ cwd = process.cwd(), settings, env = process.env }) {
  const [instructions, skills] = await Promise.all([
    scanInstructions({ cwd, settings }),
    scanSkills({ cwd, settings })
  ]);
  return {
    compatibilityMode: settings.context?.compatibilityMode ?? "claude",
    instructions,
    skills,
    rules: resolveSessionRules(settings, env)
  };
}

/**
 * Select this session's "all-sessions" Rule bodies from the dashboard-delivered
 * settings snapshot (`settings.rules`, written by the dashboard agent-config
 * snapshot). The dashboard pre-resolves per-project buckets (global+project,
 * override/inherit already honored) AND a global-only `all` bucket, so the Pod
 * picks EXACTLY ONE bucket and never re-merges:
 *   - project-scoped session (PROCWAY_SESSION_PROJECT set & present in buckets)
 *     → that project's resolved bucket.
 *   - otherwise (tenant-global chat, or project not bucketed) → `all` (global).
 * Returns an array of rule body strings (empty when none) — task-run-loop rules
 * never reach here (the dashboard filters to all-sessions before snapshotting).
 */
export function resolveSessionRules(settings, env = process.env) {
  const buckets = settings?.rules ?? {};
  const project = String(env?.PROCWAY_SESSION_PROJECT ?? "").trim();
  const projectBucket = project ? buckets.projects?.[project] : null;
  const selected = Array.isArray(projectBucket)
    ? projectBucket
    : (Array.isArray(buckets.all) ? buckets.all : []);
  return selected.filter((body) => typeof body === "string" && body.trim().length > 0);
}
