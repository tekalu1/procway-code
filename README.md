# procway-code

<!-- The CI badge points at the PUBLIC repo workflow (tekalu1/procway-code,
     .github/workflows/ci.yml — the workflow lives in the source tree and is
     carried over by publish-sync). It will 404 until the repo is flipped
     public. -->
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

While the version number carries a `-alpha` suffix, releases are published
under the `alpha` dist-tag, not `latest` — ask for it by name:

```bash
npm install -g procway-code@alpha
# or
pnpm add -g procway-code@alpha
```

Plain `npm install -g procway-code` starts working from the first stable
release; until then there is no `latest` to resolve.

Requires **Node.js ≥ 20** (tested on 20, 22 and 24).

The only runtime dependency is [`undici`](https://github.com/nodejs/undici).
One optional dependency is installed by default:

- AES-GCM session encryption with the OS keychain → `keytar` (needs a native
  build; if it is missing, only `session.encryption.provider: "os-keychain"`
  is unavailable — the `passphrase` and `none` providers are unaffected)

To skip it: `npm install -g --omit=optional procway-code@alpha`.

### Tracing (opt-in, installed separately)

OpenTelemetry is **not bundled**. It is off unless `PROCWAY_TELEMETRY` is on,
and the OTel SDK pulls in roughly 35 transitive packages — we would rather not
put that in every install for a feature most people never turn on. If you want
traces, install the packages yourself:

```bash
npm install -g @opentelemetry/sdk-node \
               @opentelemetry/exporter-trace-otlp-http \
               @opentelemetry/resources
PROCWAY_TELEMETRY=on procway-code
```

Spans go to `OTEL_EXPORTER_OTLP_ENDPOINT` (default
`http://localhost:4318/v1/traces`). With `PROCWAY_TELEMETRY` on but the
packages absent, the CLI prints one line telling you what to install and
otherwise runs normally.

The same switch also turns on **delegation metrics**: with `PROCWAY_TELEMETRY`
on, a session that delegates work (`spawn_agent`, `start_run`) writes one
cumulative JSON line to stderr, marked `__procway_metrics__`, counting how that
work was run — foreground vs background, how much of it overlapped, how long a
turn sat blocked joining it, and what the automatic wake turns cost. It needs no
extra packages, sends nothing anywhere, and contains only counts and
milliseconds: no paths, no prompts, no task text. Off unless you turn it on. The
field list is in `docs/host-contract.md`.

## Quickstart

```bash
export OPENAI_API_KEY=sk-...
procway-code "summarise the README"
```

User-wide settings are loaded from `~/.procway/ai-agent/settings.json`. To
override them for one workspace, add `.procway/ai-agent/settings.json` below
that workspace. Workspace values take precedence over user values.

Provider settings and API keys can also be saved from the CLI. Secret values are
read from stdin and are never passed as command-line arguments:

```bash
procway-code config set providers.openai-main.baseUrl https://api.openai.com/v1
procway-code model set gpt-5.4
procway-code config set-secret OPENAI_API_KEY
```

Settings and secrets written by these commands are user-wide by default and
live under `~/.procway/ai-agent/`. Use `--scope workspace` when a setting must
apply only to the current workspace:

```bash
procway-code config set --scope workspace approvalMode auto-readonly
procway-code model set --scope workspace gpt-5.4
```

Workspace secrets are also supported explicitly, but user scope is recommended
for API keys. Both workspace files are ignored by Git by default. Secret files
are created with owner-only permissions.

When upgrading from a version that wrote into the workspace, move the existing
files once before changing settings:

```bash
mkdir -p ~/.procway/ai-agent
mv -n .procway/ai-agent/settings.json ~/.procway/ai-agent/settings.json
mv -n .procway/ai-agent/secrets.json ~/.procway/ai-agent/secrets.json
```

`-n` preserves any user-wide file that already exists; merge the remaining
workspace values manually if both scopes were already configured.

From inside the interactive TUI, run `/config setup` to enter the user-wide provider,
endpoint, model, and token without leaving the session. The token prompt does
not echo its value, and the new provider is used from the next turn.

The interactive terminal shows the active workspace and model in its prompt,
uses a live activity timeline for model and tool work, and keeps session details
available through `/status`. Use `/clear` to reset the screen without losing the
conversation.

### Editing your input

The prompt is a multi-line editor, not a single readline line.

| Key | Action |
|---|---|
| `Enter` | Send the message |
| `Ctrl+J` | Insert a newline (works in every terminal) |
| `\` + `Enter` | Insert a newline (continuation, no terminal support needed) |
| `Esc` `Enter` | Insert a newline (macOS `Option+Enter` sends this) |
| `Shift+Enter` | Insert a newline — run `/terminal-setup` once to bind it |
| `Ctrl+A` / `Ctrl+E` | Start / end of line |
| `Ctrl+W` / `Ctrl+U` / `Ctrl+K` | Delete word before / to start / to end |
| `↑` / `↓` | Move between lines; at the edges, walk the persistent history |
| `Tab` | Complete a slash command or an `@path` file reference |
| `Ctrl+C` | Interrupt the running turn; at an idle prompt, clear the line (twice = quit) |
| `Esc` | Same as Ctrl+C minus the quit |
| `Ctrl+D` | Quit when the input is empty |

Pasting multiple lines pastes one message (bracketed paste), and history is kept
in `~/.procway/ai-agent/history` between sessions.

`/terminal-setup` binds `Shift+Enter` in VS Code / Cursor, iTerm2 and WezTerm. It
shows the exact diff and asks before writing anything, backs up files it changes,
and never overwrites a binding you already have.

### Display settings

Two keys under `ui` in `~/.procway/ai-agent/settings.json` control what the
terminal shows. Both are optional:

| Setting | Values | Default | Effect |
|---|---|---|---|
| `ui.thinking` | `true` / `false` | `true` | Stream the model's reasoning as it arrives. `/thinking on\|off` toggles it for the current session; `/status` shows which way it is set. |
| `ui.hyperlinks` | `true` / `false` / `"auto"` | `"auto"` | Render URLs as clickable OSC 8 links. `"auto"` uses them only in terminals known to support them (iTerm2, WezTerm, kitty, Windows Terminal, VS Code, GNOME Terminal and other VTE ≥ 0.50, ghostty, Konsole, Hyper, rio, tabby); everywhere else — and whenever colour is off — links fall back to `text (url)`. |

```json
{
  "ui": {
    "thinking": false,
    "hyperlinks": "auto"
  }
}
```

Links are only ever made from `http`/`https` URLs, so model output cannot turn
a `javascript:` or `file:` target into something clickable. Colour itself
follows the usual environment: `NO_COLOR` disables it, `FORCE_COLOR` forces it
on, and output to a pipe or `TERM=dumb` is plain text.

## Slash commands

A few of the most common ones:

| Command | Description |
|---|---|
| `/help` | List every slash command with a one-line description |
| `/status` | Show the current workspace, session, model, and modes |
| `/clear` | Clear the terminal without ending the session |
| `/config setup` | Configure a provider, endpoint, model, and API token |
| `/usage` | Token usage + cost summary |
| `/mcp` | List MCP servers; `/mcp add` adds one interactively (or `/mcp add <id> <transport> [options]`), `/mcp remove <id>` removes it. Changes reconnect the session live. |
| `/compact` | Compact the active conversation |
| `/resume` | Pick a prior session |
| `/exit` | Quit |

Run `/help` in the REPL (or type `/` and press Tab) for the full, always-current
list — the commands are defined in one place in the code, not enumerated here.

## Other ways to run it

| Command | What it does |
|---|---|
| `procway-code "prompt"` | Run one turn and exit |
| `procway-code -p "prompt"` | Same, forced non-interactive (safe in scripts and pipes) |
| `procway-code resume [sessionId]` | Reopen a previous session; with no id, pick one from a list |
| `procway-code compact [sessionId]` | Compact a session's history without entering the REPL |
| `procway-code serve` | Serve the bundled browser client + a WebSocket bridge |
| `procway-code auth login [provider]` | Sign in to a provider that supports OAuth |
| `procway-code --show-config` | Print the fully merged settings and exit |
| `procway-code --scan-context` | Show which instruction files and skills would be loaded |

`serve` binds `127.0.0.1:7777` by default and requires `PROCWAY_SERVE_TOKEN`;
pass `--host 0.0.0.0` only when you mean to expose it to the network.

`procway-code --help` lists every command and flag.

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
