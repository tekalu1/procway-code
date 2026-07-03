/**
 * Return a snapshot of the current session settings. Pure: no I/O.
 *
 * @param {{ session: { settings: object } }} input
 */
export async function configCommand({ session } = {}) {
  return { settings: session?.settings ?? null };
}
