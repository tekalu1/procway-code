export function isScannerActive(scanner, compatibilityMode) {
  if (scanner.enabled === false) return false;
  if (!Array.isArray(scanner.activeInModes) || scanner.activeInModes.length === 0) return true;
  return scanner.activeInModes.includes(compatibilityMode);
}

export function getActiveInstructionScanners(settings) {
  const mode = settings.context?.compatibilityMode ?? "claude";
  return (settings.context?.instructionScanners ?? []).filter((scanner) => isScannerActive(scanner, mode));
}

export function getActiveSkillScanners(settings) {
  const mode = settings.context?.compatibilityMode ?? "claude";
  return (settings.context?.skillScanners ?? []).filter((scanner) => isScannerActive(scanner, mode));
}
