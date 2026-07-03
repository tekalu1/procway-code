/**
 * `/plan` — toggle plan mode for the active session. Returns the new state.
 * Pure: no I/O.
 *
 * @param {{ session: { planMode?: { isActive: () => boolean, setActive: (a: boolean) => boolean, hasPending: () => boolean, pending: () => Array<object>, discard: (reason: string) => void }, sessionId: string }, args?: string[] }} input
 */
export async function planCommand({ session, args = [] } = {}) {
  if (!session?.planMode) {
    return { sessionId: session?.sessionId ?? null, active: false, available: false };
  }
  const arg = Array.isArray(args) ? (args[0] ?? "").toLowerCase() : "";
  let active;
  if (arg === "on" || arg === "enable") active = session.planMode.setActive(true);
  else if (arg === "off" || arg === "disable") active = session.planMode.setActive(false);
  else if (arg === "discard") {
    session.planMode.discard("user-discarded");
    active = session.planMode.isActive();
  } else {
    active = session.planMode.setActive(!session.planMode.isActive());
  }
  return {
    sessionId: session.sessionId,
    active,
    available: true,
    pending: session.planMode.pending().map((entry) => ({
      entryId: entry.entryId,
      name: entry.name,
      summary: entry.summary
    }))
  };
}
