import { loadMemoryIndex } from "../../memory/store.mjs";

/**
 * `/memory` — list persisted memory entries grouped by type.
 *
 * @param {{ session?: { settings?: { memory?: { homeDir?: string } } } }} input
 */
export async function memoryCommand({ session } = {}) {
  const homeDir = session?.settings?.memory?.homeDir;
  const index = await loadMemoryIndex({ homeDir });
  if (!index) {
    return { dir: null, count: 0, types: { user: 0, feedback: 0, project: 0, reference: 0 }, entries: [] };
  }
  return {
    dir: index.dir,
    count: index.memories.length,
    types: index.types,
    entries: index.memories.map((entry) => ({
      file: entry.file,
      name: entry.name,
      description: entry.description,
      type: entry.type
    }))
  };
}
