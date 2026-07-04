# procway-code

<!-- The CI badge points at the PUBLIC repo workflow (tekalu1/procway-code,
     .github/workflows/ci.yml, injected by publish-sync). It will 404 until
     the repo is flipped public. -->
[![CI](https://github.com/tekalu1/procway-code/actions/workflows/ci.yml/badge.svg)](https://github.com/tekalu1/procway-code/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Local coding agent — events-first, multi-provider (Anthropic / OpenAI / OpenRouter),
TUI-ready, headless API. Built as the agent of the
[Procway](https://github.com/tekalu1/procway) platform, and usable entirely on
its own.

`procway-code` is the CLI entry point. The same core can also be embedded as a library
through `import { createAgentSession } from "procway-code"` for headless / WebSocket /
GUI integrations.

## Install

```bash
npm install -g procway-code
# or
pnpm add -g procway-code
```

Requires **Node.js ≥ 20**. Optional features pull in optional dependencies on demand:

- AES-GCM session encryption with the OS keychain → `keytar`
- OpenTelemetry tracing → `@opentelemetry/sdk-node` + `@opentelemetry/exporter-trace-otlp-http`

## Quickstart

```bash
export OPENAI_API_KEY=sk-...
procway-code "summarise the README"
```

Drop a `procway-settings.json` in the workspace to swap providers, change approval
mode, register MCP servers, or tune sandbox / encryption settings.

## Slash commands

| Command | Description |
|---|---|
| `/help` | List available slash commands |
| `/usage` | Token usage + cost summary (replaces `/cost`) |
| `/compact` | Compact the active conversation |
| `/resume` | Pick a prior session |
| `/exit` | Quit |

## Headless API

```js
import { createAgentSession } from "procway-code";

const session = await createAgentSession({ settings, cwd, sessionId });
session.events.on("assistant.message.delta", (event) => process.stdout.write(event.deltaText));
await session.runTurn("hello");
```

## Embedding in your own app

Everything a host application must provide — the `PROCWAY_*` env contract,
filesystem layout, LLM proxying, the `serve` WebSocket protocol (incl.
`protocolVersion` negotiation), delegated-job drivers, and the optional
desktop/browser tooling — is specified in
[`docs/host-contract.md`](docs/host-contract.md).

## Contributing & security

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) (dev setup,
test commands, and the PR flow: this public repo is a one-way mirror of a
private monorepo; accepted changes are applied upstream with credit). Please
also read the [Code of Conduct](CODE_OF_CONDUCT.md), and report
vulnerabilities privately per [SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.

`src/auth/oauth/` contains code vendored from
[`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) (MIT,
Copyright (c) 2025 Mario Zechner) — see `src/auth/oauth/LICENSE.md`.
