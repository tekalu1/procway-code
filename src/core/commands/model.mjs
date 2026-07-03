import { resolveActiveModel } from "../../config/active-model.mjs";

/**
 * Return the current provider:model pair. Pure: no I/O.
 *
 * @param {{ session: { settings: object } }} input
 */
export async function modelCommand({ session } = {}) {
  const settings = session?.settings ?? {};
  return {
    provider: settings.defaultProvider ?? null,
    model: resolveActiveModel(settings)
  };
}
