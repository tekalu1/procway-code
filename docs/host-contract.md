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
| `PROCWAY_DASHBOARD_URL` | for host-API tools | — | Base URL of the host's HTTP API. Consumed by attachment transport (`GET/POST <base>/api/ai/attachments…` — `save_attachment`, `attach_file`, image hydration/delegation) and run-control tools (`<base>/api/run/jobs…` — `start_run`/`attach_run`/`get_run_status`/`resume_run`/`reply_run`). Requests authenticate with `x-procway-session: $PROCWAY_PROXY_TOKEN`. Tools that need it throw `"PROCWAY_DASHBOARD_URL is not set"` when absent — a host that does not implement these endpoints simply doesn't set it. |

### Telemetry

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_TELEMETRY` | no | off | `on`/`1`/`true`/`yes` turns telemetry on. Two independent things sit behind this ONE switch: (a) OpenTelemetry tracing — the `@opentelemetry/*` packages are **not bundled**, install them yourself (see README "Tracing"); without them the CLI runs normally and prints one line naming what to install. (b) delegation metrics — a zero-dependency, local-only counter line on stderr (below). Off means neither happens. |
| `PROCWAY_TELEMETRY_QUIET` | no | unset | Suppresses that one-line notice. Set it when embedding the CLI and you do not want the reminder on stderr. |

#### Delegation metrics line (`__procway_metrics__`)

With `PROCWAY_TELEMETRY` on, a session that delegates work writes one structured
NDJSON line to **stderr** at the end of each turn in which something changed —
the same discipline as the `__procway_crash__` line: the process states a fact,
the host decides where it goes. Nothing is sent anywhere; there is no exporter
and no dependency involved.

The line is **cumulative for the session**, so the last line is the answer and an
earlier one is a prefix of it. A session that never delegates writes nothing.

```jsonc
{
  "__procway_metrics__": true,
  "app": "ai-agent", "metric": "delegation",
  "session_id": "…", "ts": "…", "uptime_ms": 0,
  "usage":       { "spawn_agent": { "foreground": 0, "background": 0 },
                   "start_run":   { "foreground": 0, "background": 0 } },
  "concurrency": { "peak": 0, "peak_by_surface": {}, "histogram": {}, "outstanding_now": 0 },
  "join_blocked_ms":     { "spawn_agent_foreground": { "count": 0, "total_ms": 0, "max_ms": 0 }, "…": {} },
  "recoverable_join_ms": 0,
  "wake":   { "turns": 0, "items": 0, "coalesce_ratio": 0, "batch_histogram": {},
              "latency_ms": { "count": 0, "total_ms": 0, "max_ms": 0 },
              "awaiting_run_latency_ms": { "count": 0, "total_ms": 0, "max_ms": 0 },
              "inject_failures": 0 },
  "hazard": { "same_cwd_peak": 0, "same_cwd_overlaps": 0,
              "same_cwd_background_overlaps": 0, "distinct_cwds": 0 }
}
```

Counts are integers and every duration is milliseconds. `concurrency` is about
background jobs that have been started and **not yet delivered to the model**.
`hazard` is about child agents that were running **at the same time in the same
working directory**; directories are compared inside the process and are never
part of the line — no path, prompt, task text or file name is ever emitted. What
the numbers are for is ADR 0029 追補 A1 E7 Phase 3.

### Timeouts

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROCWAY_TURN_IDLE_TIMEOUT_MS` | no | `180000` | Turn-level idle watchdog: aborts a turn that produced no events for this long (paused while a UIR/approval awaits a human). `0` disables. |
| `PROCWAY_UIR_TIMEOUT_MS` | no | (removed) | No longer read. `request_user_action` is record-and-return: the request is recorded, the turn ends, and the user's answer resumes the conversation as a new turn — nothing waits in-process, so there is no timeout to configure. |
| `PROCWAY_WAKE_DRAIN_TIMEOUT_MS` | no | `300000` | `-p` only (§5 event-wake): wall-clock budget for waiting on background work after the turn returns. `0` exits as soon as the turn ends (pre-#143 behaviour). |
| `PROCWAY_WAKE_DRAIN_MAX_TURNS` | no | `20` | `-p` only: how many wake turns one invocation may run before giving up (`0` disables the drain). |
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
`abort`, `listSessions`, `loadSession`, `wake`. Unknown commands / invalid JSON are
ignored at the parse layer. `runTurn` accepts up to 16 attachments
`[{id, mime?, name?}]` — ids are host attachment ids fetched over HTTP
(§1 `PROCWAY_DASHBOARD_URL`), never read from a shared volume.

**`wake` — pushing a settled background job into the conversation** (event-wake).
A run started by the agent with `start_run { runInBackground: true }` (§5) settles in
the HOST's registry, not in this process, so the host must push that settle back:

```jsonc
// client → server
{ "kind": "command", "id": "<uuid>", "command": "wake", "args": {
    "source": "host",
    "items": [{
      "jobId": "<run job id>",             // required; an item without one is dropped
      "kind": "run",                       // "run" (default) | "agent"
      "status": "completed",               // completed | failed | awaiting-user-input | aborted | …
      "project": "acme", "ticket": "TK-12", // REQUIRED to continue with resume_run / reply_run
      "inputKind": "conversational",       // optional
      "hearing": "which database?",        // optional
      "interaction": { },                   // optional (structured UIR)
      "runSessionId": "<run session id>",  // optional
      "pendingTask": { },                   // optional (object or string — passed through opaque)
      "error": "…", "result": { }           // optional
    }]
} }

// server → client
{ "kind": "response", "id": "<uuid>", "ok": true,
  "result": { "queued": true, "accepted": 1, "deduped": 0 } }
{ "kind": "response", "id": "<uuid>", "ok": false,
  "error": { "code": "invalid_args", "message": "wake: items must be an array" } }
```

- Host responsibility: **when a run job that carries a `conversationId` reaches a
  terminal or awaiting status, push a `wake` to that conversation's session.** The
  host cannot tell whether the run was started in the background, so it should push
  unconditionally — a settle the turn already collected itself (`attach_run`,
  `resume_run`, `reply_run`) is dropped by procway-code's tombstones and reported
  back as `deduped`.
- **`conversationId` is the push's only routing key, so the host must let it be
  declared LATE** — see `POST <base>/api/run/jobs/:jobId/attach` in §5. A run
  started by something other than the agent (a Run button, a webhook, a scheduler)
  has no accompanying conversation at start time; without that endpoint such a run
  can never be woken and `attach_run` cannot block on it.
- **The push is now the ONLY settle channel — an explicit JOIN waits on it too.**
  `attach_run` (and the foreground `start_run` / `resume_run` / `reply_run`) used to
  hold its turn open by polling `GET /api/run/jobs/:jobId` every 2s; it now blocks on
  the same pushed settle, so there is exactly one wait model. A host that sets
  `PROCWAY_DASHBOARD_URL` but never sends `wake` still works, just slowly and only at
  the end: the JOIN gives up on its own deadline (kept just under the scheduler's
  tool budget) and answers with a SINGLE `GET /api/run/jobs/:jobId` — returning the
  run's real yield if it settled meanwhile, otherwise an honest "still running".
  **A host that implements `wake` but NOT the attach endpoint degrades to that same
  slow path for every run it did not start with a `conversationId`** — the settle is
  real but has nowhere to go.
- Max 32 items per push. `invalid_args` covers a non-array / empty `items`, an
  over-long batch, a mistyped field, and a batch where no item carries a `jobId`
  (nothing was queued). `wake_unavailable` means the session has no wake supervisor
  (e.g. a forked child-agent session).
- **`wake` is never rejected for concurrency.** Unlike `runTurn` — which answers
  `{code:"turn_in_progress"}` while a turn is in flight and drops the payload — a
  wake is accepted whatever the session is doing; procway-code holds it until the
  running turn ends, coalesces settles that arrive together, and then injects ONE
  synthetic turn. Do not implement wake delivery as a `runTurn`.
- The ack means "queued", not "the model has read it": the wake turn is injected
  later, detached, after a short coalescing window.

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
(process driver) and `spawn_agent` (agent driver). `spawn_agent` awaits its child
by default; with `runInBackground:true` it returns the jobId at once so several
children run concurrently, and the parent collects each one through the
`agent_job` tool (`status` / `wait` / `kill` / `list`, scoped to the calling
session's own agent-kind jobs). Hosts inject their own kinds by
importing the registry and supplying a **driver** — exactly what the procway
dashboard does for its run-loop kinds.

The run-control tools follow the same two-mode shape against the HOST's job API
(`<base>/api/run/jobs…`), even though those jobs live in the host's registry and
not in this one: `start_run` awaits the run's first yield by default, and with
`runInBackground:true` it POSTs, returns the runId, and awaits nothing — so an
orchestrator can drive several tickets at once. The JOIN is the existing
`attach_run` (the same await-yield rendezvous minus the POST), used identically
whether the host started the run or the agent started it in the background. A
background start still carries its `conversationId`, so the run's hearings
surface in the conversation that launched it.

**Host endpoints the run-control tools call.** All under `<base>` =
`PROCWAY_DASHBOARD_URL`, authenticated with `x-procway-session: $PROCWAY_PROXY_TOKEN`:

| Tool | Request |
| --- | --- |
| `start_run` | `POST /api/run/jobs` → `{ jobId, status }` |
| `attach_run` | `POST /api/run/jobs/:jobId/attach` (the declaration, below), then the settle wait |
| `get_run_status` | `GET /api/run/jobs/:jobId` → the job view |
| `resume_run` | `POST /api/run/jobs/resume` → `{ jobId, status }` |
| `reply_run` | `POST /api/run/jobs/conversational-resume` → `{ jobId, status }` |

`start_run` / `resume_run` / `reply_run` all carry `conversationId` in the POST body
(host-supplied, never model-supplied — a resume mints a NEW jobId, so the attach has
to be re-declared each time).

**`POST <base>/api/run/jobs/:jobId/attach` — declaring an attach after the fact.**
Hosts SHOULD implement this. `attach_run` means "this conversation is accompanying
this run", and a run started by anything other than the agent — a Run button in the
host's UI, a webhook, a scheduler — has no conversation recorded on it, so its settle
would be pushed to nobody and the JOIN would block to its full deadline before
falling back to one confirming read.

```jsonc
// request
{ "conversationId": "<the accompanying conversation>" }

// response: the job's state right now — the SAME shape as GET /api/run/jobs/:jobId
{ "attached": true, "jobId": "...", "status": "running",
  "project": "...", "ticket": "...", "conversationId": "...",
  "result": {}, "interaction": {}, "inputKind": "...", "hearing": "...",
  "error": "...", "updatedAt": 0 }
```

- The host owns authorization of the claim: a session may only attach a run to ITS
  OWN conversation. An unverifiable claim should be DROPPED (`attached:false`), not
  403'd — an attach is notification metadata, not an execution gate.
- The response's `status` is load-bearing: `attach_run` returns immediately, without
  waiting, when the run has ALREADY settled (`status !== "running"`). That closes
  the "it finished between the button press and the JOIN" race.
- The endpoint is OPTIONAL in the sense that a 404 (or any failure) is non-fatal:
  procway-code logs it, puts a note on the yield, and falls back to the pre-existing
  behaviour — wait for a settle that may never arrive, then one `GET /api/run/jobs/:jobId`.
  A host that skips it simply cannot let `attach_run` block usefully.
- Implementations must update BOTH the durable record and the IN-FLIGHT job: the
  wake is emitted at settle time from the running job's own metadata, so persisting
  the attach without touching the live job leaves the regression in place.

**Event-wake.** Detached work that settles after its turn has ended would otherwise
be delivered to nobody. Every session owns a supervisor that turns such a settle into
a fresh synthetic turn: in-process children arrive through `subscribeSettled`, and
run settles are pushed in by the host with the `wake` command (§4) — that push is the
host's obligation for **every** run job carrying a `conversationId`, background or
not (duplicates are dropped here). Wakes are coalesced, never interleaved with a live
turn, and suppressed for work the turn already collected. A `procway-code -p` process
additionally does not exit while its session still has uncollected background work,
bounded by `PROCWAY_WAKE_DRAIN_TIMEOUT_MS` (default 300000; `0` disables) and
`PROCWAY_WAKE_DRAIN_MAX_TURNS` (default 20).

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
yield, returns unsubscribe), `subscribeSettled(handler)` (registry-wide fan-out of
every settle — payload `{jobId, kind, status, result?, error?, meta}`, returns
unsubscribe; for consumers asking "did anything of mine finish?", which cannot
subscribe per job because the job may not exist yet when they subscribe),
`awaitJobYield(jobId)` (resolves at the next non-running yield),
`resumeJob(jobId, input)` (only from a resumable status), `killJob(jobId)`. Constructor options let a consumer widen the lifecycle:
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
