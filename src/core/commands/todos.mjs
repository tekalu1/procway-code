/**
 * `/todos` — return the agent's running todo list. Pure: no I/O.
 *
 * @param {{ session: { todoStore?: { list: () => Array<object>, summary: () => object }, sessionId: string } }} input
 */
export async function todosCommand({ session } = {}) {
  if (!session?.todoStore) {
    return { sessionId: session?.sessionId ?? null, todos: [], summary: { total: 0, pending: 0, inProgress: 0, completed: 0 } };
  }
  return {
    sessionId: session.sessionId,
    todos: session.todoStore.list(),
    summary: session.todoStore.summary()
  };
}
