#!/usr/bin/env bash
# ============================================================
# Phase A1 entrypoint — boot ai-agent serve and the desktop stack.
#
# Children, in spawn order (ADR 0020 UX: serve FIRST — the dashboard's
# readiness gate is the :$PROCWAY_SERVE_PORT probe, so the Xvfb socket wait
# must not sit on the cold-start critical path; the desktop stack boots in
# parallel and the VNC pane catches up on its own poll):
#   1. ai-agent serve  :$PROCWAY_SERVE_PORT (Node)
#   2. Xvfb            virtual display on $DISPLAY ($XVFB_RESOLUTION)
#   3. Openbox         minimal WM (renders cursor + handles window mgmt)
#   4. x11vnc          loopback :$VNC_PORT, attached to the Xvfb display
#   5. websockify      :$NOVNC_PORT, serves noVNC HTML + proxies WS to x11vnc
#
# DISPLAY-dependent agent tools (screenshot / web_browser) initialize lazily
# (agent-browser daemon starts on first use), so serve coming up a couple of
# seconds before the X stack is safe.
#
# Fail-fast: `wait -n` exits as soon as the first child dies, the trap
# kills the rest, and the container exits non-zero so dashboard's
# session-store sees the death immediately (same pattern as Phase 0).
# ============================================================
set -euo pipefail

BOOT_T0=$(date +%s%3N 2>/dev/null || echo 0)
# Boot-relative timestamps (ADR 0020 cold-start instrumentation): every log
# line carries +<ms> since entrypoint start, so `kubectl logs` shows where a
# slow boot spent its time.
log() { printf '[runtime +%sms] %s\n' "$(( $(date +%s%3N 2>/dev/null || echo 0) - BOOT_T0 ))" "$*" >&2; }

# ----- 0. Sanity ------------------------------------------------------------
: "${DISPLAY:?DISPLAY must be set (Dockerfile ENV)}"
: "${XVFB_RESOLUTION:?XVFB_RESOLUTION must be set}"
: "${VNC_PORT:?VNC_PORT must be set}"
: "${NOVNC_PORT:?NOVNC_PORT must be set}"
: "${PROCWAY_SERVE_PORT:?PROCWAY_SERVE_PORT must be set}"
: "${PROCWAY_SERVE_HOST:?PROCWAY_SERVE_HOST must be set}"
: "${PROCWAY_WORKSPACE_DIR:?PROCWAY_WORKSPACE_DIR must be set}"

if [ -z "${PROCWAY_SERVE_TOKEN:-}" ]; then
  log "FATAL: PROCWAY_SERVE_TOKEN is not set — ai-agent serve will refuse to start."
  log "       Inject it at \`docker run -e PROCWAY_SERVE_TOKEN=...\`."
  exit 64
fi

# /workspace is the only mandatory writable bind/volume; the other writable
# paths (/home/procway, /tmp, /run, /var/run) are tmpfs under the ADR 0003
# §C6 read-only-rootfs contract, so mkdir there is best-effort — fail-soft
# if the rootfs is read-only AND the path is also read-only (impossible by
# contract, but defensive).
mkdir -p "$PROCWAY_WORKSPACE_DIR"
log "workspace: $PROCWAY_WORKSPACE_DIR"

# ----- 0a. npm / XDG cache (image-global ENV) -------------------------------
# The Dockerfile points npm_config_cache + XDG_CACHE_HOME at
# /home/procway/.cache, which is a per-tenant writable mount under strict k8s
# sessions. But this same image can run WITHOUT that mount (LOCAL/CLI
# `docker run`, non-strict configs), where /home/procway is read-only-rootfs:
# `npm i` / node-gyp would then EROFS trying to write the cache. Ensure the
# configured cache dirs exist+writable; if not, fall back to a guaranteed
# tmpfs path (/tmp/.cache) and re-point the env so child tools inherit it.
cache_root="${XDG_CACHE_HOME:-${HOME:-/root}/.cache}"
if mkdir -p "${cache_root}/npm" 2>/dev/null && [ -w "${cache_root}" ]; then
  log "cache: ${cache_root} (writable)"
else
  fallback_cache="/tmp/.cache"
  mkdir -p "${fallback_cache}/npm" 2>/dev/null || true
  export XDG_CACHE_HOME="${fallback_cache}"
  export npm_config_cache="${fallback_cache}/npm"
  log "warn: ${cache_root} not writable — npm/XDG cache redirected to ${fallback_cache}"
fi

# ----- 0a2. pnpm content-addressable store ----------------------------------
# pnpm's store ignores XDG_CACHE_HOME (it follows XDG_DATA_HOME →
# ~/.local/share/pnpm/store, read-only here), so the Dockerfile pins
# npm_config_store_dir to the shared workspaces mount — same filesystem as
# the ticket worktrees (hardlinks, persists across session pods). That mount
# is absent in LOCAL/CLI `docker run`, so mirror the cache fallback above:
# redirect to the (already validated) writable cache root. Same-FS hardlinks
# are lost in the fallback, but installs still work.
store_dir="${npm_config_store_dir:-}"
if [ -n "${store_dir}" ]; then
  if mkdir -p "${store_dir}" 2>/dev/null && [ -w "${store_dir}" ]; then
    log "pnpm store: ${store_dir} (writable)"
  else
    fallback_store="${XDG_CACHE_HOME}/pnpm-store"
    mkdir -p "${fallback_store}" 2>/dev/null || true
    export npm_config_store_dir="${fallback_store}"
    log "warn: ${store_dir} not writable — pnpm store redirected to ${fallback_store}"
  fi
fi

# ADR 0008 §F2: the procway CLI now lives baked at /opt/procway. /workspace
# is the tenant's dedicated workspace subtree (NOT the procway repo), so the
# previous `install_workspace_root_if_needed` step that ran `pnpm install`
# against /workspace/pnpm-lock.yaml is gone — there is no lockfile to install
# from there anymore. The CLI resolves its deps from /opt/procway/node_modules,
# populated at image build time.

# ----- 0b. Seed NVM_DIR from the baked snapshot (Phase 4.8 §B) --------------
# NVM_DIR (/home/procway/.nvm) is a WRITABLE per-session emptyDir under the
# k8s engine — empty on EVERY Pod boot. The image bakes nvm + node 20/22 at
# /opt/nvm-snapshot; seed it so `nvm` and the prefetched node versions are
# available without a network fetch.
#
# ADR 0020 cold-start: the seed used to run SYNCHRONOUSLY before serve and
# cost ~4s per boot (measured; under gVisor the `cp -a` preserve step even
# fails after doing the work, so every spawn paid 4s for nothing). It now
# runs in the BACKGROUND after serve is up:
#   - the snapshot-PATH fallback below applies immediately, so tool shells
#     always have the right node from second zero;
#   - `cp -r --preserve=mode` instead of `cp -a` — ownership/timestamp
#     preservation is what trips gVisor, and neither matters in an emptyDir;
#   - nvm.sh lands LAST (separate copy): its presence is the "seeded"
#     sentinel for nvm-init.sh, so a tool shell can never observe a
#     half-copied version tree behind a present nvm.sh.
# Fail-soft: any failure just logs — the PATH fallback remains in effect.
NVM_DIR="${NVM_DIR:-/home/procway/.nvm}"
NVM_SNAPSHOT="${NVM_SNAPSHOT:-/opt/nvm-snapshot}"
nvm_seeded=0
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  log "nvm: NVM_DIR already seeded (skip)"
  nvm_seeded=1
elif [ ! -s "${NVM_SNAPSHOT}/nvm.sh" ]; then
  log "nvm: snapshot absent (skip)"
fi

seed_nvm_background() {
  local tmp="${NVM_DIR}/.seed-tmp"
  if ! mkdir -p "$tmp" 2>/dev/null; then
    log "warn: nvm seed skipped (NVM_DIR not writable) — snapshot PATH fallback remains"
    return 0
  fi
  if cp -r --preserve=mode "${NVM_SNAPSHOT}/." "$tmp/" 2>/dev/null \
    && (cd "$tmp" && find . -maxdepth 1 -mindepth 1 ! -name nvm.sh -exec mv {} "${NVM_DIR}/" \; 2>/dev/null) \
    && mv "$tmp/nvm.sh" "${NVM_DIR}/nvm.sh" 2>/dev/null; then
    rm -rf "$tmp" 2>/dev/null || true
    log "nvm seed complete (background)"
  else
    rm -rf "$tmp" 2>/dev/null || true
    log "warn: nvm seed failed — snapshot PATH fallback remains"
  fi
}

# ----- 0c. Snapshot-PATH fallback when nvm seed failed (B4 short-term) -------
# When NVM_DIR is NOT writable (read-only-rootfs without an .nvm mount), the
# seed above is a no-op and `nvm` is unavailable, so the project's required
# Node (e.g. .nvmrc=22.x) is unreachable and the default stays system node 20.
# The baked snapshot's node binaries ARE executable in place, so prepend the
# right snapshot bin to PATH. Prefer the worktree's .nvmrc version when a baked
# match exists; otherwise pick the highest baked version. This does NOT touch
# the seeded-volume happy path (nvm_seeded=1) — there `nvm use` is the contract.
if [ "${nvm_seeded}" != "1" ] && [ -d "${NVM_SNAPSHOT}/versions/node" ]; then
  # newest-first list of baked versions (vX.Y.Z dir names), e.g. "v22.22.3 v20.20.2"
  snapshot_versions="$(ls -1 "${NVM_SNAPSHOT}/versions/node" 2>/dev/null \
    | grep '^v[0-9]' | sort -rV || true)"
  picked_ver=""
  # Honour an .nvmrc in the workspace/worktree if it maps to a baked version.
  # The AI agent edits ticket worktrees under the SHARED workspaces tree —
  # /procway-workspaces/projects/<project>/... (PROCWAY_WORKSPACE_URI), NOT the
  # per-session scratch PVC at /workspace (PROCWAY_WORKSPACE_DIR). A project's
  # .nvmrc therefore lives a couple of levels deep under the workspaces root, so
  # search there first (projects/*/.nvmrc and one worktree level below), then
  # fall back to the scratch PVC for self-contained / no-shared-mount sessions.
  workspaces_root=""
  case "${PROCWAY_WORKSPACE_URI:-}" in
    file://*) workspaces_root="${PROCWAY_WORKSPACE_URI#file://}" ;;
  esac
  # Build the candidate list: the shared workspaces tree first (only when a
  # root resolved — guard against an empty prefix turning into an absolute
  # `/projects/*` glob), then the per-session scratch PVC as a fallback.
  nvmrc_cands=""
  if [ -n "$workspaces_root" ]; then
    nvmrc_cands="${workspaces_root}/projects/*/.nvmrc ${workspaces_root}/projects/*/*/.nvmrc ${workspaces_root}/projects/*/*/*/.nvmrc"
  fi
  nvmrc_cands="${nvmrc_cands} ${PROCWAY_WORKSPACE_DIR}/.nvmrc ${PROCWAY_WORKSPACE_DIR}/*/.nvmrc"
  nvmrc_file=""
  for cand in $nvmrc_cands; do
    [ -f "$cand" ] && { nvmrc_file="$cand"; break; }
  done
  if [ -n "$nvmrc_file" ]; then
    want="$(tr -d ' \t\r' < "$nvmrc_file" | head -n1)"
    want="${want#v}"                       # strip optional leading v
    want_major="${want%%.*}"               # 22.16.0 -> 22, or bare 22 -> 22
    for v in $snapshot_versions; do
      # exact (v22.16.0) or major-prefix (v22.) match
      case "$v" in
        "v${want}"|"v${want_major}".*) picked_ver="$v"; break ;;
      esac
    done
    [ -z "$picked_ver" ] && log "warn: .nvmrc wants '${want}' but no baked snapshot match (${snapshot_versions})"
  fi
  # Fallback to the highest baked version when .nvmrc absent / unmatched.
  [ -z "$picked_ver" ] && picked_ver="$(printf '%s\n' $snapshot_versions | head -n1)"
  if [ -n "$picked_ver" ] && [ -x "${NVM_SNAPSHOT}/versions/node/${picked_ver}/bin/node" ]; then
    export PATH="${NVM_SNAPSHOT}/versions/node/${picked_ver}/bin:${PATH}"
    log "nvm fallback: prepended snapshot ${picked_ver} to PATH ($("${NVM_SNAPSHOT}/versions/node/${picked_ver}/bin/node" -v))"
    # Expose for nvm-init.sh so the agent's tool shells inherit the same node.
    export PROCWAY_NODE_FALLBACK_BIN="${NVM_SNAPSHOT}/versions/node/${picked_ver}/bin"
  fi
fi

# ----- 1. ai-agent serve (FIRST — the readiness critical path) --------------
# `--repo-root` lets settings resolve from a path other than cwd. Prefer the
# SHARED workspaces mount (PROCWAY_WORKSPACE_URI → /procway-workspaces): that
# is the tenant subtree the dashboard can write, so its derived settings
# snapshot (.procway/ai-agent/settings.json + user-env.json, issue #30
# hot-reload) lands where serve's settings watcher is looking. Fall back to
# the per-session scratch PVC when the shared mount is absent (self-contained
# sessions, unit setups) — previous behavior, nothing ever writes there.
settings_root="$PROCWAY_WORKSPACE_DIR"
case "${PROCWAY_WORKSPACE_URI:-}" in
  file://*)
    shared_ws="${PROCWAY_WORKSPACE_URI#file://}"
    [ -d "$shared_ws" ] && settings_root="$shared_ws"
    ;;
esac
log "starting ai-agent serve on ${PROCWAY_SERVE_HOST}:${PROCWAY_SERVE_PORT} (settings root: ${settings_root})"
(
  cd "$PROCWAY_WORKSPACE_DIR" 2>/dev/null || cd /opt/ai-agent
  exec node /opt/ai-agent/src/cli.mjs serve \
    --port "$PROCWAY_SERVE_PORT" \
    --host "$PROCWAY_SERVE_HOST" \
    --repo-root "$settings_root"
) &
AGENT_PID=$!

# Background nvm seed (section 0b) — off the readiness critical path. Not in
# the wait -n list: a seed failure is fail-soft (PATH fallback stays in effect).
if [ "${nvm_seeded}" != "1" ] && [ -s "${NVM_SNAPSHOT}/nvm.sh" ]; then
  log "seeding NVM_DIR=${NVM_DIR} in the background"
  seed_nvm_background &
fi

# ----- 2. Xvfb --------------------------------------------------------------
# -nolisten tcp keeps X11 socket-only (defense in depth).
# +extension RANDR enables resolution change at runtime (future Phase A.next).
log "starting Xvfb on $DISPLAY ($XVFB_RESOLUTION)"
Xvfb "$DISPLAY" \
  -screen 0 "$XVFB_RESOLUTION" \
  -nolisten tcp \
  +extension RANDR \
  +extension RENDER \
  +extension GLX \
  -dpi 96 \
  &
XVFB_PID=$!

# Wait for the X socket to exist before launching X clients. xdpyinfo would
# be more rigorous but pulls in x11-utils we already have; simpler: poll the
# unix socket file.
display_num="${DISPLAY#:}"
display_num="${display_num%%.*}"
socket_path="/tmp/.X11-unix/X${display_num}"
for _ in $(seq 1 50); do
  [ -S "$socket_path" ] && break
  sleep 0.1
done
if [ ! -S "$socket_path" ]; then
  log "FATAL: Xvfb did not produce $socket_path within 5s"
  kill "$XVFB_PID" 2>/dev/null || true
  exit 65
fi
log "Xvfb ready (socket: $socket_path)"

# ----- 3. Openbox -----------------------------------------------------------
log "starting Openbox"
/etc/procway-runtime/xstartup.sh &
OPENBOX_PID=$!

# ----- 4. x11vnc ------------------------------------------------------------
# -forever       don't exit after first client disconnects
# -shared        allow multiple concurrent viewers (dashboard tab + dev tools)
# -nopw / -nolookup  no VNC password (auth is enforced by dashboard's WS proxy)
# -listen 127.0.0.1  loopback only; websockify is the only public face
# -localhost     extra belt-and-braces loopback bind
# -rfbport       fixed port so websockify knows where to dial
log "starting x11vnc on 127.0.0.1:${VNC_PORT}"
x11vnc \
  -display "$DISPLAY" \
  -forever -shared \
  -nopw -nolookup \
  -listen 127.0.0.1 -localhost \
  -rfbport "$VNC_PORT" \
  -quiet \
  -ncache 0 \
  &
VNC_PID=$!

# ----- 5. websockify + noVNC -----------------------------------------------
# Debian's `novnc` package installs assets at /usr/share/novnc and a small
# launcher at /usr/bin/novnc_proxy. We invoke websockify directly with
# --web pointed at the noVNC web root so the same port serves both the HTML
# UI (GET /) and the upgraded WebSocket (GET /websockify).
log "starting websockify+noVNC on 0.0.0.0:${NOVNC_PORT} -> 127.0.0.1:${VNC_PORT}"
websockify \
  --web=/usr/share/novnc \
  "0.0.0.0:${NOVNC_PORT}" \
  "127.0.0.1:${VNC_PORT}" \
  &
NOVNC_PID=$!
log "boot sequence complete (serve started first; desktop stack up)"

# ----- 6. Wait & propagate exit --------------------------------------------
trap 'log "received signal, terminating children"; kill ${AGENT_PID} ${NOVNC_PID} ${VNC_PID} ${OPENBOX_PID} ${XVFB_PID} 2>/dev/null || true' INT TERM

# `wait -n` returns when the first child exits. That child names which
# subsystem died; report it before tearing the rest down.
set +e
wait -n "${XVFB_PID}" "${OPENBOX_PID}" "${VNC_PID}" "${NOVNC_PID}" "${AGENT_PID}"
EXIT_CODE=$?
set -e

# Identify which one exited for log triage.
for entry in \
  "$XVFB_PID:xvfb" \
  "$OPENBOX_PID:openbox" \
  "$VNC_PID:x11vnc" \
  "$NOVNC_PID:websockify" \
  "$AGENT_PID:ai-agent"; do
  pid="${entry%%:*}"
  name="${entry##*:}"
  if ! kill -0 "$pid" 2>/dev/null; then
    log "child '$name' (pid=$pid) exited first (status=${EXIT_CODE})"
    break
  fi
done

log "shutting down remaining children"
kill "${AGENT_PID}" "${NOVNC_PID}" "${VNC_PID}" "${OPENBOX_PID}" "${XVFB_PID}" 2>/dev/null || true
wait || true
exit "${EXIT_CODE}"
