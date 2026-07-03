# shellcheck shell=bash
# ============================================================
# nvm init for the procway-code-runtime image (Phase 4.8 §B).
#
# Sourced via BASH_ENV (non-interactive bash) and /etc/profile.d (login
# shells), so any shell the AI agent spawns has `nvm` available as a function:
#   nvm install 18      # fetch + install another version at runtime
#   nvm use 20          # switch THIS shell to a seeded version
#
# CRITICAL — `--no-use`:
#   We load nvm but DO NOT activate any managed node. That leaves the default
#   `node`/`npm` on PATH as the image's SYSTEM node (/usr/local), exactly as
#   before nvm existed. This is the infra non-regression guarantee: the
#   entrypoint, ai-agent serve, pnpm, and gh keep running on the system node;
#   only an explicit `nvm use <ver>` in a session shell switches versions.
#
# NVM_DIR is the writable runtime mount (a per-tenant named volume); the
# entrypoint seeds it from /opt/nvm-snapshot on first boot. If that seed hasn't
# happened (or the volume is absent), `nvm.sh` simply isn't there and we
# no-op — never failing a shell startup.
# ============================================================
export NVM_DIR="${NVM_DIR:-/home/procway/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  \. "$NVM_DIR/nvm.sh" --no-use
elif [ -n "${PROCWAY_NODE_FALLBACK_BIN:-}" ] && [ -x "${PROCWAY_NODE_FALLBACK_BIN}/node" ]; then
  # B4 short-term fallback: the nvm seed failed (read-only NVM_DIR), so `nvm`
  # is unavailable. The entrypoint resolved a baked snapshot node and exported
  # its bin dir; prepend it here so the agent's tool shells reach that Node
  # instead of falling back to system node 20. Idempotent: skip if already on
  # PATH (BASH_ENV is sourced per non-interactive bash invocation).
  case ":${PATH}:" in
    *":${PROCWAY_NODE_FALLBACK_BIN}:"*) : ;;
    *) export PATH="${PROCWAY_NODE_FALLBACK_BIN}:${PATH}" ;;
  esac
fi
