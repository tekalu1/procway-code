import { listSessions, loadSessionState } from "../../session/store.mjs";
import { migrateLegacyFormatIfNeeded } from "../../session/migration.mjs";

/**
 * Resolve a sessionId for resumption. Runs legacy migration first.
 * Returns either `{ sessionId, state }` or `{ sessions }` when no sessionId
 * was provided so adapters can prompt the user to pick one.
 *
 * `cwd` is used to filter the listing (sessions are stored globally under
 * `~/.procway/ai-agent/sessions/` and remember their originating workspace
 * via `meta.cwd`). Pass `cwd: null` to list every session regardless of
 * workspace.
 *
 * @param {{ cwd?: string | null, sessionId?: string }} input
 */
export async function resumeCommand({ cwd, sessionId } = {}) {
  if (cwd === undefined) throw new TypeError("resumeCommand: cwd is required");
  await migrateLegacyFormatIfNeeded();
  if (!sessionId) {
    const { sessions } = await listSessions({ cwd, limit: 200 });
    return { sessions };
  }
  const state = await loadSessionState({ sessionId });
  return { sessionId, state };
}
