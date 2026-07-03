import { resolveContext } from "../../context/context-resolver.mjs";

/**
 * Resolve and summarize the current workspace context (instructions / skills).
 *
 * @param {{ cwd: string, settings: object }} input
 */
export async function contextCommand({ cwd, settings } = {}) {
  if (!cwd) throw new TypeError("contextCommand: cwd is required");
  const context = await resolveContext({ cwd, settings });
  return {
    compatibilityMode: context.compatibilityMode,
    instructions: (context.instructions ?? []).map((item) => ({
      scannerId: item.scannerId,
      compatibility: item.compatibility,
      path: item.path,
      bytes: typeof item.content === "string" ? item.content.length : 0
    })),
    skills: (context.skills ?? []).map((item) => ({
      scannerId: item.scannerId,
      compatibility: item.compatibility,
      priority: item.priority,
      path: item.path,
      bytes: typeof item.content === "string" ? item.content.length : 0
    }))
  };
}
