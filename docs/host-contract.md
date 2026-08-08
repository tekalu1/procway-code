# Host Contract

What an application ("host") must provide to embed `procway-code` — as a spawned
`procway-code serve` process, or as a library via `createAgentSession`. The procway
dashboard is the reference host (one runtime container per session, driven over
WebSocket). Everything below is derived from the source under `src/`; treat this file
as the contract, not a tutorial.

## 1. Environment contract

All host-supplied configuration is read from `PROCWAY_*` environment variables at
process start (plus settings files, §2). Everything is optional unless noted.

### Mode & core config

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_MODE` | no | — | `plan` forces plan mode on (`settings.plan.enabled = true`). Any other value is ignored. |
| `PROCWAY_CODE_PROVIDER` | no | settings `defaultProvider` | Overrides the default provider id. |
| `PROCWAY_CODE_MODEL` | no | provider `defaultModel` | Spawn-time model bootstrap. A `defaultModel` pinned in the *workspace* settings file for the active provider wins over this env (live hot-reload channel beats frozen Pod env); an explicit `--model` CLI flag beats both. |
| `PROCWAY_CODE_APPROVAL_MODE` | no | settings `approvalMode` | Overrides the approval mode. |
| `PROCWAY_CODE_COMPATIBILITY_MODE` | no | — | Sets `settings.context.compatibilityMode`. |

### Provider / LLM proxy

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_PROVIDER_BASE_URL` | no | — | Together with `PROCWAY_CODE_PROVIDER`, synthesizes a provider entry inline (no settings.json needed): `{ type, baseUrl, defaultModel?, apiKeyEnv? }`. This is how a host points a session at its own LLM proxy (§3). |
| `PROCWAY_PROVIDER_TYPE` | no | value of `PROCWAY_CODE_PROVIDER` | `type` of the synthesized provider (e.g. `anthropic-via-proxy`). |
| `PROCWAY_PROVIDER_API_KEY_ENV` | no | — | Name of the env var holding the API key for the synthesized provider. Not needed for `*-via-proxy` types. |
| `PROCWAY_PROXY_TOKEN` | proxy mode only | — | Session-scoped bearer token presented to the host's LLM proxy and host HTTP APIs (§3). Read only when the provider type is `*-via-proxy` (LLM) or when calling `PROCWAY_DASHBOARD_URL` endpoints. |

### serve (WebSocket bridge)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_SERVE_TOKEN` | **yes** for `serve` | — | Auth token for the WS bridge. `serve` refuses to start when unset/blank (whitespace-only values are rejected). Clients pass it as `?token=` (§4). |

### Session identity & persistence

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_SESSION_ID` | no | — | Host-assigned session id, used to tag crash-report lines (structured `__procway_crash__` JSON on stderr) and `attach_file` uploads. Does **not** pick the AgentSession id — that is chosen per WS connection (`?session=`/`?resume=`, §4). |
| `PROCWAY_SESSION_PROJECT` | no | — | Marks the session as project-scoped: selects the project's rules bucket from settings, injects the project-context prompt section, and seeds the active project for user-env resolution (runtime-mutable via the `active-project` marker file, §2). |
| `PROCWAY_SESSION_PASSPHRASE` | if encryption `provider: "passphrase"` | — | Passphrase for session-at-rest encryption; key = scrypt(passphrase, fixed salt). Startup of an encrypting session throws when missing. |

### Workspace

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_WORKSPACE_DIR` | no | session cwd | Writable per-session scratch directory. Used as the home of the `active-project` marker (the shared workspace may be mounted read-only) and referenced in the system prompt as the ephemeral scratch space. |
| `PROCWAY_WORKSPACE_URI` | no | `/procway-workspaces` (prompt fallback) | Location of the shared, durable workspace tree, as a `file://` URI or bare path. Used to render the project-context prompt (`<root>/projects/<project>/production/code/<repo>`, `.../backlogs/<ticket>/code/<repo>`) and to locate `.procway-connections.json` for integration tools. |

### Tools / network

| Variable | Required | Optional default | Purpose |
|---|---|---|---|
| `PROCWAY_NET_ALLOW` | no | unset = allow all | Comma-separated host suffixes (e.g. `api.github.com,anthropic.com`) gating `web_search`/`web_fetch` egress (`safeFetch`). A non-matching host yields decision `ask` — routed through the approval pipeline, not hard-blocked. |
| `PROCWAY_DASHBOARD_URL` | for host-API tools | — | Base URL of the host's HTTP API. Consumed by attachment transport (`GET/POST <base>/api/ai/attachments…` — `save_attachment`, `attach_file`, image hydration/delegation) and run-control tools (`<base>/api/run/jobs…` — `start_run`/`get_run_status`/`resume_run`/`reply_run`). Requests authenticate with `x-procway-session: $PROCWAY_PROXY_TOKEN`. Tools that need it throw `"PROCWAY_DASHBOARD_URL is not set"` when absent — a host that does not implement these endpoints simply doesn't set it. |

### Telemetry

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_TELEMETRY` | no | off | `on`/`1`/`true`/`yes` enables OpenTelemetry tracing. The `@opentelemetry/*` packages are **not bundled** — install them yourself (see README "Tracing"). Without them the CLI runs normally and prints one line naming what to install. |
| `PROCWAY_TELEMETRY_QUIET` | no | unset | Suppresses that one-line notice. Set it when embedding the CLI and you do not want the reminder on stderr. |

### Timeouts

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_TURN_IDLE_TIMEOUT_MS` | no | `180000` | Turn-level idle watchdog: aborts a turn that produced no events for this long (paused while a UIR/approval awaits a human). `0` disables. |
| `PROCWAY_UIR_TIMEOUT_MS` | no | (removed) | No longer read. `request_user_action` is record-and-return: the request is recorded, the turn ends, and the user's answer resumes the conversation as a new turn — nothing waits in-process, so there is no timeout to configure. |
| `PROCWAY_LLM_HEADERS_TIMEOUT_MS` | no | `60000` | Max wait for LLM response headers (undici). |
| `PROCWAY_LLM_BODY_TIMEOUT_MS` | no | `120000` | Max gap between LLM response body chunks before the stream is treated as dead. |

### OAuth

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_OAUTH_CALLBACK_HOST` | no | `127.0.0.1` | Bind host for the local OpenAI/Codex OAuth callback server (port 1455). |

### Referenced but not read by the agent

| Variable | Direction | Purpose |
|---|---|---|
| `PROCWAY_CLI` | host → session shell env | Never read via `process.env` by agent code. Injected runner task prompts and some tool descriptions instruct the model to run `node "$PROCWAY_CLI" …` in `run_shell`, so a procway host exports it into the session environment as the path to its CLI. Non-procway hosts can ignore it. |
| `PROCWAY_MCP_HOST_CLI` | agent → child process | Set *by* the agent when it spawns an external agent CLI with injected MCP config; not a host input. |

## 2. Filesystem contract

### Session store (`src/session/store.mjs`)

```
~/.procway/ai-agent/sessions/
  index.json                 # listing index: {sessions: {<id>: {title, cwd, updatedAt, origin, sessionContext, …}}}
  <sessionId>/
    events.jsonl             # append-only event log
    snapshot.json            # projection: messages, usage, todos, planMode, alwaysAllow
    meta.json                # sessionId, title, cwd, provider, model, createdAt/updatedAt, origin, procwayMeta, sessionContext
    transcript.md            # best-effort plaintext transcript (skipped when encryption is on)
```

The root can be relocated by callers via the `sessionsDir`/`homeDir` parameters
(library use); the dashboard scopes tenants by passing a per-tenant subtree. Session
ids default to a timestamp (`createSessionId`); caller-chosen ids arriving via
`?session=` are restricted to `[A-Za-z0-9][A-Za-z0-9_-]{0,99}` because they become
directory names.

**Encryption at rest** (`src/session/encryption.mjs`): AES-256-GCM, files prefixed
with the ASCII magic `PROCWAYE` + version byte + 12-byte IV + 16-byte tag. Providers
(`settings.session.encryption.provider`): `none` (default), `passphrase`
(`PROCWAY_SESSION_PASSPHRASE`, scrypt with a fixed salt), `os-keychain` (optional
`keytar` dep; generates and stores a random key). Plaintext files stay readable —
the reader falls back to `JSON.parse` when the magic is absent.

### Configuration files

Merge order (later wins): built-in defaults → env (§1) → user scope → workspace
scope → CLI flags.

```
~/.procway/ai-agent/                    # user scope
  settings.json
  secrets.json                          # {ENV_NAME: value} applied to process.env at boot
  auth-profiles.json                    # OAuth token store (e.g. ChatGPT/Codex)
<workspace>/.procway/ai-agent/          # workspace scope (workspace = repoRoot ?? cwd)
  settings.json
  secrets.json
  auth-profiles.json
  user-env.json                         # host-distributed user env vars (hot-reloaded; PROCWAY_* keys are reserved and dropped)
  active-project                        # runtime-mutable active-project marker; written under PROCWAY_WORKSPACE_DIR when the workspace is read-only
<workspace>/.procway-connections.json   # host-written integration credentials (chmod 600) for MCP integration tools
```

`serve` hot-reloads `settings.json` / `secrets.json` / `user-env.json` so host edits
take effect on the next turn without a restart.

### Workspace directories

The agent's cwd is the working tree for tools. A host may treat it as durable (plain
CLI usage) or as an ephemeral per-session scratch (`PROCWAY_WORKSPACE_DIR`) alongside
a durable shared tree (`PROCWAY_WORKSPACE_URI`) — the latter layout is only
prompt-advertised when `PROCWAY_SESSION_PROJECT` is set (§1, Workspace).

## 3. LLM access

Two modes, selected by provider config (`settings.providers.<id>.type`):

**Direct.** `type: anthropic | openai | openai-compatible | openai-codex …` with
`apiKeyEnv` naming an env var that holds the real API key. The agent calls the
provider directly (`<baseUrl>/v1/messages` for Anthropic, `<baseUrl>/chat/completions`
for OpenAI-compatible).

**Host LLM proxy** (`*-via-proxy` types: `anthropic-via-proxy`, `openai-via-proxy`,
`openai-codex-via-proxy`). The session holds **no API key**. The host:

1. Runs an HTTP relay that speaks the provider's wire protocol verbatim at
   `PROCWAY_PROVIDER_BASE_URL` (same paths as direct mode; request/response bodies —
   including streaming and `cache_control` — pass through untouched).
2. Injects per-session env: `PROCWAY_CODE_PROVIDER=<id>`,
   `PROCWAY_PROVIDER_BASE_URL=<proxy>`, `PROCWAY_PROVIDER_TYPE=<id>-via-proxy` (or
   configures the provider in settings), `PROCWAY_CODE_MODEL=<model>`, and a
   session-scoped `PROCWAY_PROXY_TOKEN`.
3. On each request, verifies `Authorization: Bearer <PROCWAY_PROXY_TOKEN>` (the only
   credential the agent sends; for Anthropic the agent omits `x-api-key` entirely),
   **strips that inbound Authorization**, attaches the real upstream credential, and
   forwards.

When `PROCWAY_PROXY_TOKEN` is unset (local/single-tenant), via-proxy requests are
sent unauthenticated — the proxy decides whether to accept that.

## 4. serve protocol (WebSocket)

`procway-code serve [--port 7777] [--host 127.0.0.1]` starts an HTTP server that
serves the built-in test client (`web/`) and upgrades WebSockets on path **`/ws`**.
Binding a public host (`0.0.0.0`, `::`) logs a warning; token auth still applies.

**Token gate.** Every upgrade must carry `?token=<PROCWAY_SERVE_TOKEN>`. Comparison
is constant-time (`crypto.timingSafeEqual`); missing/wrong token → HTTP 401, wrong
path → 404, non-WebSocket upgrade → 400.

**Connection query parameters** (all optional except `token`):

| Param | Meaning |
|---|---|
| `resume=<id>` | Resume an existing persisted session. A missing/broken session falls back to a fresh one (non-fatal). |
| `session=<id>` | Create-or-resume with a **caller-chosen** id (`[A-Za-z0-9][A-Za-z0-9_-]{0,99}`). Wins over `resume` when both are sent. |
| `cwd=<abs path>` | Per-connection working-directory override. |
| `origin=<tag>` | Labels the session at creation (`[A-Za-z0-9_-]{1,64}`; e.g. `worker`); persisted and used by `listSessions` origin filtering. Persisted origin wins on resume. |
| `hearingMode=return` | `request_user_action` records-and-returns instead of blocking the turn (run-loop worker mode). |

**Message kinds** (`src/adapters/serve/protocol.mjs`). JSON text frames:

- server → client: `ready`, `event` (every AgentSession event, `{kind:"event", event}`),
  `response` (`{kind:"response", id, ok, result | error}`; `error` is a string or
  `{code, message}`), `error` (`{kind:"error", error, fatal}`)
- client → server: `command` (`{kind:"command", command, id?, args?}`)

**COMMANDS**: `runTurn`, `approve`, `interaction.resolve`, `compact`, `history`,
`abort`, `listSessions`, `loadSession`. Unknown commands / invalid JSON are ignored
at the parse layer. `runTurn` accepts up to 16 attachments `[{id, mime?, name?}]` —
ids are host attachment ids fetched over HTTP (§1 `PROCWAY_DASHBOARD_URL`), never
read from a shared volume.

**Ready handshake & versioning.** Immediately after the upgrade the server sends:

```json
{ "kind": "ready", "sessionId": "<id>", "version": "<package version>", "protocolVersion": 1 }
```

- `protocolVersion` (integer, currently **1**) is the protocol contract;
  `version` is the package version, informational only.
- Compat policy: backward-compatible additions (new commands, new fields on
  existing messages) keep the number; breaking changes (message shapes,
  semantics of existing COMMANDS) bump it.
- Hosts must gate in their `ready` parser: treat a missing `protocolVersion`
  (pre-negotiation agents) as `1`, and fail loudly when the value is outside the
  supported range — never mis-operate silently. Opaque WS relays in between need
  not (and should not) parse frames to gate.
- Clients should wait for `ready` before sending commands (commands that race the
  handshake are buffered server-side as a robustness measure, not a guarantee).

## 5. Delegated jobs (`src/jobs/delegated-jobs.mjs`)

The generic background-job registry — "spawn → run detached → stream progress →
yield on completed/failed/awaiting-input → resume → kill/evict" — is owned by
procway-code (ADR 0030 D2) and is deliberately neutral (`node:crypto` +
`node:events` only, no knowledge of any driver). procway-code registers its own
kinds on the process-wide singleton (`getSharedJobRegistry()`): `shell_job`
(process driver) and `spawn_agent` (agent driver). Hosts inject their own kinds by
importing the registry and supplying a **driver** — exactly what the procway
dashboard does for its run-loop kinds.

```js
import { DelegatedJobRegistry, getSharedJobRegistry } from "procway-code/jobs";

registry.spawnJob({ kind, spec, driver, jobId?, meta? })  // → { jobId, status: "running" } (synchronous)
```

(In-monorepo, the procway dashboard reaches the same module by dynamic file-URL
import instead of the package export.)

**Driver contract:**

```
driver.start(spec, { onEvent, onYield, jobId }) => handle
  onEvent(e)                                   progress / liveness heartbeats (ring buffer, cap 500)
  onYield({ status, result?, error?, awaiting?, ttlMs? })
                                               settle: completed / failed / awaiting-input /
                                               any consumer-specific status; ttlMs overrides
                                               the eviction window for this settle
  handle = { kill(), resume?(input), …kind-specific extensions }
```

`start` may return a promise of the handle; a sync throw or rejection settles the
job as `failed` (never crashes the host process). Registry API: `getJob`,
`getJobHandle`, `subscribeJob(jobId, handler)` (replays the ring buffer + current
yield, returns unsubscribe), `awaitJobYield(jobId)` (resolves at the next
non-running yield), `resumeJob(jobId, input)` (only from a resumable status),
`killJob(jobId)`. Constructor options let a consumer widen the lifecycle:
`resumableStatuses` (default `["awaiting-input"]`), `noEvictStatuses` (default
`["awaiting-input"]` — never evicted), `ttlMs` (terminal-job eviction, default
30 min). All driver/subscriber callbacks are exception-isolated.

## 6. Optional desktop/browser tools & reference runtime image

`desktop_action` (xdotool + scrot against an X display) and `web_browser`
(agent-browser daemon driving a headed Chromium) are **optional** capabilities with
auto-detection: they require their binaries (`xdotool`, `scrot`, `agent-browser`,
Chromium) and a reachable X server (`DISPLAY`), and are unavailable when the
environment lacks them — hosts do not need to provide any of this to embed the
agent. Browser binary/launch settings live under `settings.tools.browser`; the
detection honors those overrides (`binary`, `executablePath`, `display`, and
`headed: false`, which drops the `DISPLAY` requirement) as well as
`AGENT_BROWSER_EXECUTABLE_PATH`, mirroring what execution resolves.

The probe result is cached per process. `procway-code serve` re-probes
automatically when the settings/secrets hot-reload fires (so fixing
`AGENT_BROWSER_EXECUTABLE_PATH`/`DISPLAY` via `secrets.json` or editing
`settings.tools.browser` re-enables the tools for **new** sessions without a
restart); a library host that mutates `process.env` or installs the binaries
after startup must call the exported `invalidateDisplayToolAvailability()` —
or restart the process — before creating the next session. Already-created
sessions keep the tool catalog they registered with.

The standard full-featured environment is the reference runtime image
(`docker/runtime/` recipe, bundled with this repo): Xvfb `:1` + Openbox + x11vnc +
noVNC (`:6080`) + `procway-code serve` (`:7777`), one short-lived container per
session. Use it (or replicate its provisioning) when you want desktop/browser tools;
plain shell/file/web tools work anywhere Node ≥ 20 runs.
