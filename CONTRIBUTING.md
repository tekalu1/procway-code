# Contributing to procway-code

Thanks for your interest in contributing! `procway-code` is the standalone
coding agent of the [Procway](https://github.com/tekalu1/procway) platform —
usable on its own as a CLI, or embedded as a library (see
[`docs/host-contract.md`](docs/host-contract.md)).

## How this repository is developed (please read first)

This public repository is a **one-way mirror of a private monorepo** (its
`ai-agent/` directory, promoted to this repo's root). Maintainers develop in
the monorepo, and an automated sync publishes the content here by fully
replacing the tree in a single commit.

Practical consequences for contributors:

- **PRs are welcome here** and are reviewed here, but they are **not merged
  via the GitHub merge button** — a merge would be overwritten by the next
  sync. Instead, maintainers apply the accepted change to the upstream
  monorepo **with credit** (`Co-authored-by:` trailer preserving your name and
  email), and it ships back to this repository in the next sync. Your PR is
  then closed with a comment linking the change.
- **Open an issue first for anything non-trivial** (new features, behavior
  changes, refactors).
- **CLA**: contributions require signing the Contributor License Agreement
  (`docs/legal/CLA.md` in this repository). A bot prompts you on your first
  PR; you sign by posting the comment it asks for. Signatures are recorded on
  the `cla-signatures` branch.

Issues about the Procway platform itself (dashboard, deployment, Kubernetes
runtime) belong in [`tekalu1/procway`](https://github.com/tekalu1/procway);
this repository is only the agent.

## Development setup

Requires Node.js >= 20 and pnpm (pinned via `packageManager` in
`package.json`). The repo is standalone — no services needed:

```bash
pnpm install --frozen-lockfile
pnpm lint     # eslint over src/core
pnpm test     # vitest
```

CI runs exactly these on Node 20 and 22 (see `.github/workflows/ci.yml`),
plus a secret scan (gitleaks, config in `.gitleaks.toml`) — do not commit
credentials, even fake-looking ones.

Notes:

- `src/auth/oauth/` is vendored from `@earendil-works/pi-ai` (MIT) — its
  `LICENSE.md` and file headers must not be modified or removed (see
  `NOTICE`).
- `docker/runtime/` is a reference image recipe that assumes the Procway
  monorepo as build context; it is not buildable from this repo alone.

## Pull request checklist

- One logical change per PR; include tests for behavior changes.
- `pnpm lint` and `pnpm test` pass locally.
- Fill in the PR template, including the CLA acknowledgement.

## Reporting issues

Use the issue templates. For security vulnerabilities do **not** open a public
issue — see [SECURITY.md](SECURITY.md).
