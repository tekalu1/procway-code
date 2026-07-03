# ============================================================
# Phase A1 — procway-code-runtime image.
#
# One short-lived container per AI session. Hosts:
#   - Xvfb :1               (1280x800x24 virtual display)
#   - Openbox               (minimal WM, no panel/menu)
#   - x11vnc                (loopback :5900)
#   - websockify + noVNC    (:6080 inside container)
#   - ai-agent serve        (Node, :7777 inside container)
#
# Designed for runc today; runsc (gVisor) / Firecracker tomorrow.
# Contracts (ADR 0002 §マルチテナント契約):
#   - No --network=host expected
#   - No --privileged expected
#   - Workspace bind mount is dev-only (prod git-clones in entrypoint)
# ============================================================

# ---------------------------------------------------------------------------
# git ≥ 2.48 build stage — bookworm ships git 2.39, which predates
# `worktree.useRelativePaths` (git 2.48+). That config makes git itself write
# view-independent RELATIVE worktree link paths on every `git worktree
# add/repair` — closing the admin-dir hijack recurrence window for git
# commands the session-side agent runs directly (see ticket.service.ts
# enableRelativeWorktreePaths; the production repos carry the config). No
# bookworm / backports package exists, so build from source.
#   - sysconfdir=/etc: system config stays at /etc/gitconfig, shared with the
#     distro git (the credential-helper + safe.directory RUN below writes
#     there and must be honored by BOTH gits).
#   - INSTALL_SYMLINKS: libexec builtins as symlinks (not hardlinks) so the
#     COPY into the final stage stays small and link-structure-safe.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS git-build
ARG GIT_VERSION=2.49.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gcc make libcurl4-openssl-dev libexpat1-dev libssl-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://www.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.gz" | tar -xz -C /tmp \
 && make -C "/tmp/git-${GIT_VERSION}" -j"$(nproc)" \
      prefix=/usr/local sysconfdir=/etc \
      NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PERL=YesPlease INSTALL_SYMLINKS=YesPlease \
      all strip \
 && make -C "/tmp/git-${GIT_VERSION}" \
      prefix=/usr/local sysconfdir=/etc \
      NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PERL=YesPlease INSTALL_SYMLINKS=YesPlease \
      DESTDIR=/git-dist install

FROM node:20-bookworm-slim

# ---------------------------------------------------------------------------
# OS packages.
# Phase A: liberal install for discovery; trim in a later optimization pass.
# Size budget: target ~1.0 GB; Chromium dominates (~250 MB).
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    # process supervision + diagnostics
    tini ca-certificates curl wget bash less procps gnupg \
    # ai-agent's typical tool surface
    git ripgrep jq unzip openssh-client \
    # native npm deps (node-gyp) need a C/C++ toolchain + make. Heaviest add in
    # this list (~200 MB); kept because Phase A is "liberal install for
    # discovery" and node-gyp builds fail hard without it.
    build-essential \
    # virtual display + window manager + VNC bridge
    xvfb openbox x11vnc novnc websockify \
    xauth dbus-x11 x11-utils x11-xserver-utils \
    # desktop_action tool: xdotool drives mouse/keyboard, scrot captures screen
    xdotool scrot \
    # noVNC's websockify needs python3; openbox-xdg-autostart needs PyXDG
    python3 python3-xdg \
    # browser the agent drives via agent-browser (web_browser tool, ADR 0007)
    chromium \
    # fonts — minimal Latin + Japanese (~30 MB, vs fonts-noto-cjk's 200 MB)
    fonts-dejavu-core fonts-ipafont \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# GitHub CLI (gh) — installed from upstream apt repo (Debian's repos lag a
# major version or two). Token is injected per-session as GH_TOKEN env by
# the dashboard's session-store from the OAuth credential stored under
# connections.github (ADR 0004 Phase 1). git itself uses the credential
# helper baked below; the two paths are intentionally independent because
# gh reads GH_TOKEN / ~/.config/gh/hosts.yml and ignores git's helper.
# ---------------------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# pnpm via npm (NOT corepack). Matches Phase 0 finding O-3:
# `packageManager: pnpm@8.15.1` in root pkg would trigger an auto-download
# we don't want; bypass corepack and pin pnpm 9.15.4 globally.
ENV COREPACK_ENABLE_STRICT=0
RUN npm install -g pnpm@9.15.4 && pnpm --version

# Pre-seed corepack's pnpm cache so a project whose `packageManager` field
# pins a different pnpm (e.g. popism-v2 wants pnpm@10.11.0) can be honoured
# WITHOUT a registry round-trip — the session Pod's egress is locked down, so
# corepack's lazy auto-provision (download-on-first-use) would otherwise fail.
# `prepare` only populates the cache (under COREPACK_HOME); it does NOT change
# the default `pnpm` on PATH (that stays the npm-global 9.15.4 above), so the
# infra non-regression guarantee holds. Add versions here as projects need them.
ENV COREPACK_HOME=/opt/corepack
RUN corepack prepare pnpm@10.11.0 pnpm@9.15.4 \
 && corepack pnpm@10.11.0 --version

# ---------------------------------------------------------------------------
# nvm + Node prefetch (Phase 4.8 §B).
#
# Goal: let an AI session `nvm install <ver>` / `nvm use <ver>` at runtime
# WITHOUT a network round-trip for the common versions, while NOT disturbing
# the image's system node (this base IS node:20 at /usr/local; the agent's own
# tooling runs on it). Two hard constraints:
#
#   1. system node (/usr/local) is preserved — we never prepend nvm to PATH in
#      the image ENV, and nvm-init.sh sources nvm with `--no-use` so the default
#      node / PATH stay system. This keeps infra (entrypoint, ai-agent serve,
#      pnpm, gh) on the exact node it ships with today → non-regression.
#   2. NVM_DIR is a WRITABLE mount at runtime (/home/procway/.nvm, a per-tenant
#      named volume bound by docker-engine.ts). A read-only image dir there
#      would block runtime `nvm install`. So we bake the populated nvm tree at a
#      neutral /opt/nvm-snapshot and the entrypoint seeds NVM_DIR from it on
#      first boot (cp -a, idempotent). NVM_DIR itself stays EMPTY in the image.
#
# nvm v0.40.1 pinned (the project tags releases; pin for reproducibility).
ENV NVM_VERSION=0.40.1
RUN set -eux; \
    export NVM_DIR=/opt/nvm-snapshot; \
    # PROFILE=/dev/null: the installer otherwise appends `export NVM_DIR=...` +
    # source lines to ~/.bashrc/profile pointing at the SNAPSHOT path. Our own
    # /etc/profile.d/nvm.sh (with the runtime NVM_DIR + --no-use) is the single
    # source of shell init, so suppress the installer's profile edits.
    export PROFILE=/dev/null; \
    mkdir -p "$NVM_DIR"; \
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash; \
    # nvm.sh は bash/zsh 前提。Docker の既定シェル /bin/sh(dash) + `set -u` だと
    # nvm.sh 内の未設定変数参照で `_: parameter not set` (exit 2) になるため、
    # source + install は **bash サブシェル**(nounset なし)で実行する。
    # build 時は `--no-use` を付けない（`nvm install` を効かせるため）。この
    # シェルは throwaway でイメージの runtime PATH には影響しない。
    bash -c 'set -e; export NVM_DIR=/opt/nvm-snapshot; \
      . "$NVM_DIR/nvm.sh"; \
      nvm install 20; \
      nvm install 22; \
      nvm alias default 22; \
      nvm cache clear'

# NVM_DIR points at the WRITABLE runtime mount (per-tenant volume), NOT the
# baked snapshot — the entrypoint seeds the snapshot into it on first boot.
# BASH_ENV makes non-interactive bash (the agent's tool shells) source the init
# so `nvm` is a function there; --no-use inside keeps system node the default.
ENV NVM_DIR=/home/procway/.nvm
COPY docker/runtime/nvm-init.sh /etc/profile.d/nvm.sh
ENV BASH_ENV=/etc/profile.d/nvm.sh
RUN chmod 0644 /etc/profile.d/nvm.sh

# ---------------------------------------------------------------------------
# ai-agent source.
#
# AI_AGENT_SOURCE controls how the ai-agent code reaches the container:
#   copy  (prod / CI): source is baked at /opt/ai-agent. Required for the
#                      future runsc/Firecracker swap (no bind mounts).
#   mount (local dev): /opt/ai-agent is bind-mounted from host at runtime,
#                      enabling hot iteration on ai-agent code. The COPY
#                      lines below still run at build time (to provide a
#                      working image), but the runtime mount shadows them.
# ---------------------------------------------------------------------------
ARG AI_AGENT_SOURCE=copy

WORKDIR /opt/ai-agent

# Install prod deps first so source edits don't bust the dep cache.
# --ignore-scripts skips keytar's native rebuild (optional dep, not used here).
COPY ai-agent/package.json ai-agent/pnpm-lock.yaml ./
RUN pnpm install --prod --no-frozen-lockfile --ignore-scripts \
 && pnpm store prune

# agent-browser (vercel-labs/agent-browser) — the `web_browser` tool's backend
# (ADR 0007). Rust CLI shipped as a prebuilt binary via npm; pinned because the
# project moves fast. We deliberately do NOT run `agent-browser install` (which
# would download a separate Chrome for Testing, ~250 MB): the tool reuses the
# system chromium installed above via AGENT_BROWSER_EXECUTABLE_PATH.
RUN npm install -g agent-browser@0.27.0 && agent-browser --version

COPY ai-agent/src ./src
COPY ai-agent/web ./web
COPY ai-agent/README.md ai-agent/LICENSE ./

# ---------------------------------------------------------------------------
# Git credential helper.
#
# Bake the procway credential helper into the image at a stable path so any
# `git push/fetch` inside the session container — whether against the procway
# repo at /workspace or against project ticket worktrees under
# /procway-workspaces — picks up the PAT/token saved by the dashboard UI.
#
# The helper reads ${WORKSPACE_DIR}/.procway-git-credentials.json (which is
# /procway-workspaces/.procway-git-credentials.json inside this container
# thanks to the PROCWAY_WORKSPACE_URI env below) and emits username/password
# to git's credential protocol. Silent fallthrough when the file is absent,
# so prod-mode containers (no workspaces bind) Just Work without GitHub.
#
# host git uses the same script from `<repo>/scripts/`; this is the
# container-local copy so we don't depend on /workspace being mounted.
# ---------------------------------------------------------------------------
COPY scripts/git-credential-procway.mjs /usr/local/lib/procway-git-credential-helper.mjs
RUN chmod +x /usr/local/lib/procway-git-credential-helper.mjs \
 && git config --system credential.https://github.com.helper \
      '!node /usr/local/lib/procway-git-credential-helper.mjs' \
 # ticket worktrees under /procway-workspaces are owned by uid 1000 (dashboard's
 # `git worktree add`), but the session container runs as root (uid 0). git
 # 2.35.2+ refuses to operate on a tree it doesn't own ("detected dubious
 # ownership"), killing every status/log/diff/commit. A `--system` safe.directory
 # of '*' trusts any tree regardless of cwd — needed because the strict session
 # Pod's $HOME is volatile, so a per-user `--global` entry wouldn't survive.
 # The session is a single-tenant sandbox, so trusting all local trees is safe.
 && git config --system --add safe.directory '*'

# ---------------------------------------------------------------------------
# procway CLI bake (ADR 0008 §F2).
#
# Previously the session container reached the CLI via a bind mount of the
# procway repo at /workspace (PROCWAY_CLI=/workspace/cli/procway.mjs), which
# exposed dashboard/skills/docker/.claude source to the AI session. The CLI
# (and packages/core it imports) now ships baked at /opt/procway so the
# session does NOT need procway source on /workspace at all — dev mode
# binds only a dedicated workspace subtree.
#
# Layout inside the image mirrors the host repo so the CLI's relative
# import `../packages/core/src/lib/workspace-migrate.mjs` resolves
# verbatim. pnpm install at /opt/procway populates root deps (undici,
# @libsql/client) AND the workspace-linked @procway/core, then we strip
# host node_modules first because pnpm's symlink forest on the host
# points at host paths that don't resolve inside Linux.
# ---------------------------------------------------------------------------
COPY cli /opt/procway/cli
COPY packages /opt/procway/packages
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /opt/procway/
RUN find /opt/procway -type d -name node_modules -prune -exec rm -rf {} + \
 && cd /opt/procway && pnpm install --prod --no-frozen-lockfile --ignore-scripts \
 && pnpm store prune

# (ADR 0030 D2: the shared delegated-job registry now lives INSIDE the ai-agent
# (ai-agent/src/jobs/delegated-jobs.mjs, pure node) — the ADR 0029 P4-era
# /opt/packages sibling symlink for the cross-package import is gone;
# /opt/ai-agent resolves the registry self-contained.)

# ---------------------------------------------------------------------------
# git ≥ 2.48 overlay (see the git-build stage header). /usr/local/bin
# precedes /usr/bin on PATH, so this wins over the distro git installed in
# the apt layer (kept as fallback); /etc/gitconfig written above is shared by
# both via sysconfdir=/etc. Runtime libs (libcurl4 via curl, libexpat1 via
# python3, zlib/libssl) are already present in this image.
# ---------------------------------------------------------------------------
COPY --from=git-build /git-dist/usr/local/ /usr/local/
RUN git --version | grep -q "git version 2.4[89]\|git version 2.[5-9]" \
 && git config --system --list | grep -q safe.directory

# ---------------------------------------------------------------------------
# procway CLI discovery (issue #69 follow-up).
#  1. `procway` wrapper on PATH — the CLI was reachable only as
#     `node "$PROCWAY_CLI" …`, which worker prompts spell out but chat
#     sessions had no way to discover (`which procway` came back empty).
#  2. /AGENTS.md + /CLAUDE.md — ai-agent's instruction scanner walks UP from
#     the session cwd to "/", so a root-level instruction file reaches every
#     session (chat panes at /workspace, workers in the tenant worktrees)
#     without writing into tenant-owned directories. Both filenames are baked
#     (symlink) because the scanner picks AGENTS.md in codex/mixed
#     compatibility mode and CLAUDE.md in claude mode (the default).
# ---------------------------------------------------------------------------
RUN printf '#!/bin/sh\nexec node /opt/procway/cli/procway.mjs "$@"\n' > /usr/local/bin/procway \
 && chmod +x /usr/local/bin/procway
COPY docker/runtime/AGENTS.md /AGENTS.md
RUN ln -s /AGENTS.md /CLAUDE.md

# ---------------------------------------------------------------------------
# Desktop / runtime config.
# ---------------------------------------------------------------------------
RUN mkdir -p /etc/procway-runtime /workspace /home/procway/.config/openbox
COPY docker/runtime/openbox/rc.xml /home/procway/.config/openbox/rc.xml
COPY docker/runtime/xstartup.sh /etc/procway-runtime/xstartup.sh
COPY docker/runtime/entrypoint.sh /usr/local/bin/runtime-entrypoint.sh
RUN chmod +x /etc/procway-runtime/xstartup.sh /usr/local/bin/runtime-entrypoint.sh

# Environment contract — children inherit DISPLAY :1; serve binds 0.0.0.0
# because the container's port is published to a host-controlled port.
# PROCWAY_SERVE_TOKEN must be injected at `docker run` time (per-session).
#
# PROCWAY_WORKSPACE_URI is set so the credential helper can locate
# .procway-git-credentials.json from ANY cwd inside the container —
# ticket worktrees under /procway-workspaces/projects/... have no
# procway-settings.json on their ancestor path, so the helper's
# walk-up discovery would otherwise fail there.
ENV DISPLAY=:1 \
    HOME=/home/procway \
    # The image runs as root (no USER directive). getpwuid(0) reports /root,
    # but our writable runtime mounts hang off HOME=/home/procway, so make the
    # identity env explicit and consistent with HOME. USER/LOGNAME were unset,
    # which left some tools guessing (empty $USER).
    USER=root \
    LOGNAME=root \
    # npm's default cache (~/.npm) sits under the read-only-rootfs parent
    # /home/procway with no writable mount, so `npm i` / node-gyp would EROFS.
    # /home/procway/.cache IS a writable per-tenant mount (entrypoint mkdir's
    # it), so point npm/XDG caches there. yarn honours the same dir; pnpm's
    # metadata cache does too, but its content-addressable STORE does not —
    # see npm_config_store_dir below.
    npm_config_cache=/home/procway/.cache/npm \
    XDG_CACHE_HOME=/home/procway/.cache \
    # pnpm's store follows XDG_DATA_HOME (default ~/.local/share/pnpm/store),
    # NOT XDG_CACHE_HOME — unset here, so `pnpm install` died with
    # `ENOENT: mkdir /home/procway/.local` on the read-only rootfs. Point the
    # store at the shared workspaces mount: same filesystem as the ticket
    # worktrees (hardlinks work — no per-install copy) and it persists across
    # session pods, so a tenant pays the package download once. tmpfs paths
    # (/tmp, ~/.cache: 1GiB) are NOT viable — a single large repo's store
    # overflows them. entrypoint.sh §0a2 falls back to a writable cache path
    # when this mount is absent (LOCAL/CLI `docker run` without the volume).
    npm_config_store_dir=/procway-workspaces/.pnpm-store \
    PROCWAY_RUNTIME=1 \
    PROCWAY_WORKSPACE_DIR=/workspace \
    PROCWAY_WORKSPACE_URI=file:///procway-workspaces \
    PROCWAY_CLI=/opt/procway/cli/procway.mjs \
    PROCWAY_SERVE_PORT=7777 \
    PROCWAY_SERVE_HOST=0.0.0.0 \
    NOVNC_PORT=6080 \
    VNC_PORT=5900 \
    XVFB_RESOLUTION=1280x800x24 \
    CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage" \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage" \
    AGENT_BROWSER_HEADED=1

EXPOSE 6080 7777

# Healthcheck: noVNC HTTP + ai-agent serve static root both 200.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${NOVNC_PORT}/" >/dev/null \
   && curl -fsS "http://127.0.0.1:${PROCWAY_SERVE_PORT}/" >/dev/null \
   || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/runtime-entrypoint.sh"]
