/**
 * Resolve the active model for the current `defaultProvider`.
 *
 * Models are stored per-provider under `providers.<id>.defaultModel`.
 * Returns `null` when the active provider has no defaultModel (e.g. cli-agent
 * providers carry the model inside `args` and have no separate model field).
 */
export function resolveActiveModel(settings) {
  const providerId = settings?.defaultProvider;
  if (!providerId) return null;
  const provider = settings?.providers?.[providerId];
  return provider?.defaultModel ?? null;
}
