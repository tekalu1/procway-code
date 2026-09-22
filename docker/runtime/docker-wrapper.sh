#!/usr/bin/env bash
# ============================================================
# `docker` wrapper for the docker-enabled runtime image (ADR 0040 §D6).
#
# gVisor's netstack implements no NAT at all (MASQUERADE / SNAT / DNAT /
# REDIRECT / `-m addrtype` are all unsupported), so dockerd runs with
# --iptables=false and two everyday behaviours break:
#
#   1. `docker build` has no outbound route on the default bridge.
#      → inject `--network=host` unless the caller chose a network, and SAY SO.
#   2. `docker compose` cannot resolve service names (docker's embedded DNS at
#      127.0.0.11 is a NAT redirect).
#      → warn once; do NOT block the run.
#
# The design rule is the ADR's: absorb the limit, never hide it. A wrapper that
# silently changed the build network would make "works locally, fails here"
# undebuggable, so every injection prints one line on stderr.
#
# Everything else is passed through untouched. Installed at /usr/local/bin/docker,
# which precedes /usr/bin on PATH; the real CLI is called by ABSOLUTE path so the
# wrapper can never re-enter itself.
# ============================================================
set -uo pipefail

# Absolute path on purpose: resolving via PATH would find this wrapper again.
REAL_DOCKER="${PROCWAY_REAL_DOCKER:-/usr/bin/docker}"

self_real="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
real_real="$(readlink -f "$REAL_DOCKER" 2>/dev/null || printf '%s' "$REAL_DOCKER")"
if [ ! -x "$REAL_DOCKER" ] || [ "$self_real" = "$real_real" ]; then
  echo "[procway] docker wrapper: the real docker CLI is not at ${REAL_DOCKER} (set PROCWAY_REAL_DOCKER to override)." >&2
  exit 127
fi

# Warn at most once per Pod boot. /tmp is tmpfs under the session contract, so a
# fresh Pod warns again — a marker on the PVC ($HOME/.procway) would show the
# compose limitation exactly once ever and then stay silent for the PVC's whole
# life, which is the opposite of what §D6 asks for.
COMPOSE_WARN_MARKER="${TMPDIR:-/tmp}/.procway-docker-compose-dns-warned"

exec_real() { exec "$REAL_DOCKER" "$@"; }

args=("$@")
n=${#args[@]}
[ "$n" -gt 0 ] || exec_real "$@"

# Global flags may precede the subcommand (`docker --context foo build .`).
# Skip flags; the ones that take a SEPARATE value need their value skipped too,
# otherwise the value would be mistaken for the subcommand. Anything we fail to
# classify simply falls through to a plain pass-through — this wrapper errs
# toward doing nothing rather than toward rewriting a command it misread.
first_non_flag() { # $1 = start index; echoes the index, or -1
  local i="$1"
  while [ "$i" -lt "$n" ]; do
    case "${args[$i]}" in
      -c|--context|-H|--host|-l|--log-level|--config|--tlscacert|--tlscert|--tlskey)
        i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *)  printf '%s' "$i"; return 0 ;;
    esac
  done
  printf '%s' -1
}

sub_idx="$(first_non_flag 0)"
[ "$sub_idx" -ge 0 ] || exec_real "$@"
sub="${args[$sub_idx]}"

# `docker build …` and `docker buildx build …` are the same case; buildx puts the
# real verb one token later (possibly after buildx-level flags).
build_idx=-1
case "$sub" in
  build)
    build_idx="$sub_idx"
    ;;
  buildx)
    verb_idx="$(first_non_flag $((sub_idx + 1)))"
    if [ "$verb_idx" -ge 0 ] && [ "${args[$verb_idx]}" = build ]; then
      build_idx="$verb_idx"
    fi
    ;;
  compose)
    if [ ! -e "$COMPOSE_WARN_MARKER" ]; then
      : > "$COMPOSE_WARN_MARKER" 2>/dev/null || true
      echo "[procway] docker compose: service-name DNS does NOT work in this session." >&2
      echo "[procway]   docker's embedded resolver (127.0.0.11) needs NAT, which gVisor's netstack does not implement," >&2
      echo "[procway]   so containers cannot reach each other by service name. Container-to-container by IP and" >&2
      echo "[procway]   published ports (-p / ports:) DO work. See ADR 0040 §D6." >&2
    fi
    ;;
esac

if [ "$build_idx" -lt 0 ]; then
  exec_real "$@"
fi

# An explicit --network (either spelling) always wins — the user asked for it.
i=$((build_idx + 1))
while [ "$i" -lt "$n" ]; do
  case "${args[$i]}" in
    --network|--network=*) exec_real "$@" ;;
  esac
  i=$((i + 1))
done

echo "[procway] docker build: injected --network=host — the default bridge has no outbound route under gVisor (ADR 0040 §D6). Pass --network=<mode> explicitly to override." >&2

# Insert right after the build verb, before any positional context path.
new_args=()
for ((i = 0; i < n; i++)); do
  new_args+=("${args[$i]}")
  [ "$i" -eq "$build_idx" ] && new_args+=("--network=host")
done
exec_real "${new_args[@]}"
