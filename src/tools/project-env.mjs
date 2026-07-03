/**
 * ADR 0024 Phase 3 — `load_project_env` tool (effectful, values NEVER returned).
 *
 * Switches the ACTIVE project whose env vars are injected into the agent's shell
 * for a multi-project session (e.g. Slack, or the AI screen working across
 * projects). It writes the active-project marker (Phase 2) and re-applies the
 * env immediately, so the NEXT tool subprocess (run_shell, …) inherits the new
 * project's vars. It deals in PROJECT NAMES and ENV-VAR KEY NAMES only — secret
 * VALUES never flow back into the model context / transcript / logs.
 *
 * Exposed both as a native procway tool and (via the MCP host) to sub-CLIs.
 */
import { setActiveProject, getAvailableProjects } from "../config/user-env.mjs";

export async function loadProjectEnv({ project } = {}) {
  let active;
  let available;
  try {
    ({ project: active, available } = await setActiveProject(project));
  } catch (err) {
    if (err?.code === "PROJECT_NOT_AVAILABLE") {
      const list = getAvailableProjects();
      return {
        kind: "run_shell",
        summary: `load_project_env: ${err.message}`,
        data: {
          ok: false,
          error: err.message,
          availableProjects: list,
          message: `${err.message}. Available projects: ${list.join(", ") || "(none)"}.`,
        },
      };
    }
    throw err;
  }

  // KEY NAMES + secret flags only — never values.
  const rendered = available.map((e) => `${e.key}${e.isSecret ? " (secret)" : ""}`);
  const n = available.length;
  const summary = active
    ? `Active project → "${active}" (${n} env var${n === 1 ? "" : "s"})`
    : `Active project cleared (${n} tenant env var${n === 1 ? "" : "s"})`;

  return {
    kind: "run_shell",
    summary,
    data: {
      ok: true,
      project: active,
      count: n,
      keys: available.map((e) => ({ key: e.key, isSecret: e.isSecret })),
      message: active
        ? `Activated project "${active}". These env vars are now set in your shell — reference them as $NAME in commands; never print, echo, or log secret values: ${rendered.join(", ") || "(none)"}.`
        : `Cleared the active project. Tenant env vars available: ${rendered.join(", ") || "(none)"}.`,
    },
  };
}
