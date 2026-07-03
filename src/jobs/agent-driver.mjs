/**
 * ADR 0029 Phase 3 — `agent` kind driver for the delegated-job registry.
 *
 * This is a thin adapter over the existing `createChildAgentManager`
 * (`child-agent.mjs`); P4 removes the redundancy. The registry becomes the
 * front door for sub-agents (`spawn_agent`), while child-agent stays the
 * impl — inline (fresh AgentSession in-process) and fork (child-worker.mjs).
 * We do NOT reimplement the global concurrency semaphore or the maxDepth
 * check — they stay in the manager and the driver just calls into it. The
 * driver only translates the manager's run-to-completion promise into the
 * driver contract:
 *
 *   start({ task, childCwd, depth }, { onEvent, onYield })
 *     → emits a synchronous `agent.started` event (task/cwd/depth)
 *     → throttled `agent.progress` liveness heartbeats while the child runs
 *       (works for BOTH inline and fork, even when the child is silent — keeps
 *        the awaiting parent turn's idle watchdog fed)
 *     → forwards the child's own progress (inline session events / fork IPC)
 *       as `agent.activity` events — best-effort, never throws into the child
 *     → on completion: onYield({ status:'completed',
 *                                result:{ text, sessionId, exitCode, depth, cwd } })
 *     → on error:      onYield({ status:'failed', error, result:{ exitCode } })
 *
 * The returned handle exposes `kill()` (aborts the inline session / forked
 * child via an AbortSignal the manager honors).
 *
 * TODO(ADR 0029): an INTERACTIVE agent kind is the future capability the
 * registry contract ALREADY allows — a child would surface its hearings as
 * `awaiting-input` yields, the main agent would relay them (conversational /
 * structured), and `registry.resumeJob(jobId, answer)` would route the answer
 * back through a `resume()` on this handle. P3 deliberately keeps children
 * interactive=false (run-to-completion), so `resume` is intentionally absent;
 * enabling it requires unlocking child session interactivity (a later phase).
 */

const HEARTBEAT_MS = 15000;

export function createAgentDriver({ childAgentManager } = {}) {
  return {
    kind: "agent",
    start(spec, { onEvent, onYield }) {
      const { task, childCwd, cwd, depth } = spec ?? {};
      const resolvedChildCwd = childCwd ?? cwd ?? ".";
      const startedAtMs = Date.now();
      let settled = false;

      // Synchronous first event — mirrors process-driver's `process.started` so
      // the registry buffers job identity before spawnJob returns.
      onEvent({
        type: "agent.started",
        task: typeof task === "string" ? task.slice(0, 120) : "",
        cwd: resolvedChildCwd,
        depth,
      });

      const heartbeat = setInterval(() => {
        if (settled) return;
        onEvent({ type: "agent.progress", runningSec: Math.floor((Date.now() - startedAtMs) / 1000) });
      }, HEARTBEAT_MS);
      // Never pin the agent event loop on a child's liveness heartbeat.
      heartbeat.unref?.();

      // kill() aborts the inline session / forked child through this signal (the
      // child-agent manager honors it). spawn_agent awaits to completion, but the
      // registry contract supports kill, so wire it for real.
      const ac = new AbortController();

      const finish = (yld) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        onYield(yld);
      };

      // Run DETACHED: spawnJob returns synchronously; the await happens via
      // awaitJobYield on the registry. The manager.run call is SYNCHRONOUS (so
      // its onEvent tap + abort signal are wired before start returns), but a
      // synchronous throw is funneled into a rejected promise so it settles the
      // job as failed cleanly instead of escaping spawnJob's try.
      let runPromise;
      try {
        runPromise = childAgentManager.run({
          task,
          childCwd: resolvedChildCwd,
          ...(depth !== undefined ? { depth } : {}),
          onEvent: (e) => { try { onEvent({ ...e, type: "agent.activity", childType: e?.type }); } catch { /* best-effort */ } },
          signal: ac.signal,
        });
      } catch (err) {
        runPromise = Promise.reject(err);
      }
      Promise.resolve(runPromise)
        .then((childResult) => {
          finish({
            status: "completed",
            result: {
              text: childResult?.text ?? "",
              sessionId: childResult?.sessionId,
              exitCode: childResult?.exitCode ?? 0,
              depth: childResult?.depth,
              cwd: childResult?.cwd,
            },
          });
        })
        .catch((err) => {
          finish({ status: "failed", error: err, result: { exitCode: err?.exitCode ?? 1 } });
        });

      return {
        kill: () => {
          try { ac.abort(); } catch { /* ignore */ }
          clearInterval(heartbeat);
          return { killed: true };
        },
        // resume is intentionally absent (P3 children are run-to-completion).
      };
    },
  };
}
