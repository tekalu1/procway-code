# Security Policy

This policy applies to the Procway open-source repositories:

- [`tekalu1/procway`](https://github.com/tekalu1/procway) — the platform
  (dashboard, deployment, runtime)
- [`tekalu1/procway-code`](https://github.com/tekalu1/procway-code) — the
  standalone agent

## Supported versions

Procway does not maintain long-term support branches yet. Security fixes land
on `main` (and in the latest release, where releases exist). Please make sure
you are on the latest `main` before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately via GitHub Security Advisories on the
affected repository:

- <https://github.com/tekalu1/procway/security/advisories/new>
- <https://github.com/tekalu1/procway-code/security/advisories/new>

Include what you can: affected component/version or commit, reproduction
steps, and impact assessment. If the issue involves the managed Procway
service rather than the open-source code, say so in the report and we will
route it accordingly.

## What to expect

This is a small project; handling is **best-effort**. We aim to acknowledge
reports within a few business days, keep you informed while we investigate,
credit reporters in the fix (unless you prefer otherwise), and publish an
advisory once a fix has shipped.

There is currently **no bug bounty program** — reports are appreciated, but no
monetary reward is offered.
