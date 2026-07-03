# procway-code

Local coding agent — events-first, multi-provider (Anthropic / OpenAI / OpenRouter),
TUI-ready, headless API.

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

## License

MIT — see `LICENSE`.
