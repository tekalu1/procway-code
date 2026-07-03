/**
 * Fatal-crash reporter (ADR 0013 / Phase 1 T1-16).
 *
 * The ai-agent runs inside the *untrusted* session container (Phase 0.5
 * credential-broker model): it holds no secrets and must not have an outbound
 * Sentry DSN. So instead of talking to Sentry directly, it emits a structured
 * crash line to stderr on uncaughtException / unhandledRejection. The dashboard
 * — the trust boundary that already holds credentials and runs Sentry with the
 * shared maskSecrets denylist — tails the session's stderr and relays the crash
 * to Sentry with tenant/user/session tags. This keeps the isolation boundary
 * intact while still satisfying "ai-agent abnormal termination reaches Sentry".
 *
 * Zero dependencies on purpose (ai-agent only ships `undici`). Masking is the
 * dashboard's job on ingest, so we emit the raw message/stack here.
 */

const CRASH_MARKER = '__procway_crash__'

/** Emit one structured crash line the dashboard relay recognises by marker. */
function emitCrash(kind, err) {
  const payload = {
    [CRASH_MARKER]: true,
    level: 'fatal',
    app: 'ai-agent',
    kind,
    message: err && err.message ? String(err.message) : String(err),
    stack: err && err.stack ? String(err.stack) : null,
    session_id: process.env.PROCWAY_SESSION_ID || null,
    ts: new Date().toISOString(),
  }
  try {
    process.stderr.write(JSON.stringify(payload) + '\n')
  } catch {
    /* stderr unavailable — nothing more we can do during a crash */
  }
}

let installed = false

/**
 * Install process-level handlers for fatal errors. Idempotent. Re-throws after
 * emitting so the existing exit path (non-zero exit code) is preserved.
 */
export function installCrashHandlers() {
  if (installed) return
  installed = true

  process.on('uncaughtException', (err) => {
    emitCrash('uncaughtException', err)
    // Preserve fail-loud: a corrupted process should exit, not limp on.
    process.exitCode = 1
  })

  process.on('unhandledRejection', (reason) => {
    emitCrash('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)))
  })
}

export { CRASH_MARKER, emitCrash }
