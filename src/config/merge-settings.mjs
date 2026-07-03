export function mergeSettings(...settingsList) {
  let merged = {};
  for (const settings of settingsList) {
    if (!isPlainObject(settings)) continue;
    merged = mergeValue(merged, settings);
  }
  return merged;
}

function mergeValue(base, override) {
  if (Array.isArray(override)) {
    return [...override];
  }
  if (!isPlainObject(override)) {
    return override;
  }
  const result = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    result[key] = mergeValue(result[key], value);
  }
  return result;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
