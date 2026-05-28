# agmux — MVP Slice Design

**Date:** 2026-05-28
**Status:** Design (spec). Implementation plan is a separate document.
**Builds on:** [`docs/agmux-foundation.md`](../../agmux-foundation.md) and [`docs/spikes/2026-05-27-bun-pty/SPIKE_REPORT.md`](../../spikes/2026-05-27-bun-pty/SPIKE_REPORT.md).

This spec details the first end-to-end milestone called out in foundation §13: `protocol + store + hub + wrapper` (+ `cli`, promoted to MVP). It does not re-derive foundation principles; it commits to concrete shapes that respect them.

---

## 1. Scope

### 1.1 Success criterion

A user runs `agmux run <profile>`, the agent (Claude Code or Codex) launches inside a tmux window under PTY-transparent wrapping, the session is recorded with full metadata (including tmux coords) in a queryable store, and later:

- `agmux ls` finds the session.
- `agmux attach <id>` re-enters it — switching to its tmux window if alive, agent-native-resuming (or fresh-relaunching, see §4.4) if dead.
- `agmux inspect <id>` returns the full record + recent events.
- `agmux kill <id>` terminates it cleanly.

Works on macOS and Linux.

### 1.2 Packages shipped in MVP

Bun monorepo, `packages/*`. Five packages:

| Package | Role |
|---|---|
| `@agmux/protocol` | Shared TS types: event/session shapes, event kind+version enums, the `AGMUX_SESSION_ID` contract, JSON schemas for ingest validation. Zero runtime. |
| `@agmux/store` | SQLite DB layer: schema + migrations, append-only `events` table + `sessions` projection, query API. Embedded; no network. Interface designed to keep the door open for Postgres later. |
| `@agmux/hub` | The daemon: HTTP/JSON server on `127.0.0.1:<port>`, ingest endpoint, query endpoint, projection maintenance, drain-from-fallback-queue on startup. Auto-spawned by wrapper/CLI when absent. |
| `@agmux/wrapper` | The `agmux-wrap` binary: PTY passthrough via `bun:ffi openpty + Bun.spawn` (per spike), id minting, env injection, profile resolution, tmux bootstrap, lifecycle + heartbeat emission, write-through fallback queue. |
| `@agmux/cli` | The `agmux` binary: `run`, `ls`, `attach`, `kill`, `inspect`. Hands `run` off to the wrapper; other verbs hit the hub query API and (for `attach`/`kill`) drive tmux directly. |

### 1.3 Out of MVP (foundation-allowed, just not yet)

- `@agmux/adapters`, `@agmux/tui`, `@agmux/dashboard`, `@agmux/insights`, `@agmux/comms`.
- Output / stream capture (no stdout / stderr persistence).
- In-session events (prompts, tool calls, token usage) — these arrive with adapters.
- Subagent spawning + `parent_session_id` use (column exists, always null in MVP).
- `project` use (column exists, always null in MVP; CLI has no `--project` flag yet).
- Multi-host (B) deployment. Architecture preserves it; no remote testing.
- Token auth, TLS (localhost-only; the foundation's §11 stance).
- Hub idle auto-shutdown (runs until killed in MVP).
- `switch` interactive picker (deferred; `ls` + `attach <id>` cover the workflow for MVP).

---

## 2. Wrapper (`@agmux/wrapper`)

Binary: `agmux-wrap` (Bun-compiled standalone). Invoked indirectly via `agmux run <profile>`; users don't normally call it by hand, but it stays a separate package so it can be Go-rewritten later per foundation §9.

### 2.1 Launch sequence

1. **Resolve profile** from `~/.config/agmux/config.toml` (XDG; `$XDG_CONFIG_HOME` honored). Yields: `agent_kind`, `command`, `args`, `env`, `cwd`, optional `resume_template` (ignored in MVP; reserved for adapters).
2. **Mint canonical id.** UUIDv7 (sortable). If `AGMUX_SESSION_ID` is already set in the parent env (the CLI `attach`-after-death path sets it), reuse that value instead. This is the single hard rule from foundation §5.
3. **Determine tmux placement:**
   - If `$TMUX` is set, the wrapper is already inside a tmux pane — record those coords (`tmux display-message -p '#{session_name}\t#{window_id}\t#{pane_id}'`) and run in place.
   - If `$TMUX` is unset:
     - Ensure a tmux session named `agmux` exists (`tmux new-session -d -s agmux` if not).
     - Create a new window in it named `<profile>-<short_id>`.
     - Record the resulting `tmux_session/window/pane`.
     - Re-exec into that window so the agent runs there, then `tmux attach -t agmux:<window>` to put the user in front of it. Exact handoff mechanic deferred to implementation (see §7.1).
4. **Allocate PTY** via `openpty()` (bun:ffi → libSystem on darwin, libutil/libc on linux), `dup` the slave fd ×3 for the three stdio slots (spike gotcha #3), plug into `Bun.spawn`. Resize uses the TinyCC `cc()` shim (spike gotcha #4) with the inline-source-to-tmpdir trick for `--compile` (spike gotcha #5). `TIOCSWINSZ` constant differs darwin↔linux; resolved per-platform at runtime.
5. **Inject env:** `AGMUX_SESSION_ID=<uuid>`, `AGMUX_HUB_URL=http://127.0.0.1:<port>`, profile-defined env, plus parent env passthrough.
6. **Emit `session.started`** to the hub (write-through queue if unreachable; see §5.1).
7. **Heartbeat loop:** every 30s emit `session.heartbeat` with `{ pid_alive, winsize:{rows,cols} }`. Cadence is a constant for MVP; configurable later.
8. **On child exit:** capture exit code / signal, emit `session.ended` with `{ exit_code, signal?, reason:'normal'|'signal'|'pane_closed' }`, then re-raise own signal (per spike gotcha — `process.removeAllListeners(sig)` before re-raise) or `process.exit(code)`.

### 2.2 Loss / death detection

- **Tmux pane closed by user** → wrapper gets SIGHUP → emits `session.ended { reason:'pane_closed' }`.
- **Wrapper signaled (SIGTERM/SIGINT)** → handler emits `session.ended { reason:'signal' }`, re-raises.
- **Wrapper SIGKILL'd** → no event. Heartbeat simply stops. Projection treats absence-of-heartbeat for >2× the interval (>60s) as `status='lost'`, computed lazily at query time (no background sweeper).

### 2.3 Native session id

`native_session_id` stays null in MVP. Populating it requires per-agent_kind knowledge that belongs in `@agmux/adapters`. The column exists; the data model and CLI are designed so adapters slot in without changes.

---

## 3. Hub (`@agmux/hub`)

Binary: `agmux-hub` (Bun-compiled standalone). Normally auto-spawned, not invoked by hand.

### 3.1 Lifecycle

- Wrapper or CLI checks `~/.agmux/hub.pid` + `~/.agmux/hub.port`. If pidfile is stale (proc absent) or missing, spawn the hub detached (`Bun.spawn({ stdio:['ignore','ignore','ignore'], detached:true }).unref()`), wait until the port file is fresh and `GET /health` returns 200 (5s timeout).
- Hub picks an ephemeral free port at startup, atomically writes `hub.port.tmp` → `hub.port`, then binds.
- Hub runs until externally killed in MVP (no idle auto-shutdown).

### 3.2 Transport & endpoints

`Bun.serve()` on `127.0.0.1:<port>`. JSON over HTTP.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe (used by spawn race + manual debugging). |
| `POST` | `/ingest` | Body: one event or batch. Validates against protocol schema, appends to event log, updates projections in the same transaction. Returns 202. Idempotent on `event_id`. |
| `GET` | `/sessions` | Query sessions projection. Filters: `?status`, `?agent_kind`, `?profile`, `?since`, `?limit`. |
| `GET` | `/sessions/:id` | Single session row + last N events. Powers `inspect`. |
| `GET` | `/events` | Raw event log query. Filters: `?session_id`, `?kind`, `?since`, `?limit`. |

### 3.3 Projection maintenance

On each ingested event, the hub applies it to the `sessions` projection inside the same SQLite transaction as the event-log append. Rebuild capability: `agmux-hub --rebuild-projections` truncates projections and replays the event log.

### 3.4 Fallback-queue drain

On startup, the hub scans `~/.agmux/queue/*.jsonl`, ingests every line (idempotent via `event_id`), deletes drained files.

### 3.5 No auth

Binds 127.0.0.1 only. Foundation §11 stance. Path to (B) is the same server bound to a loopback that the user's SSH/Tailscale tunnel forwards; the HTTP/JSON API does not change.

---

## 4. Data model (`@agmux/protocol` + `@agmux/store`)

Single SQLite database at `~/.agmux/agmux.sqlite` via `bun:sqlite`. WAL mode. Schema versioned in a `_meta` table; migrations are forward-only and additive (foundation §6, §7).

### 4.1 Tables

**`events`** — append-only source of truth.

```sql
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL UNIQUE,                -- ULID, minted at wrapper; ingest idempotency key
  ts            TEXT NOT NULL,                       -- ISO-8601 UTC, ms precision
  session_id    TEXT NOT NULL,                       -- FK to sessions.session_id
  kind          TEXT NOT NULL,                       -- e.g. 'session.started'
  version       INTEGER NOT NULL DEFAULT 1,          -- per-kind schema version
  payload       TEXT NOT NULL,                       -- JSON; validated for known kinds, stored raw for unknown
  host          TEXT NOT NULL                        -- hostname; future-proofs (B)
);
CREATE INDEX idx_events_session ON events(session_id, id);
CREATE INDEX idx_events_kind_ts ON events(kind, ts);
```

**`sessions`** — projection. Rebuildable from `events`.

```sql
CREATE TABLE sessions (
  session_id            TEXT PRIMARY KEY,            -- canonical UUIDv7
  agent_kind            TEXT NOT NULL,               -- 'claude' | 'codex'
  profile               TEXT,                        -- e.g. 'claude-work'
  native_session_id     TEXT,                        -- null in MVP
  command               TEXT NOT NULL,
  args_json             TEXT NOT NULL,               -- JSON array
  env_json              TEXT NOT NULL,               -- JSON object (overrides only)
  cwd                   TEXT NOT NULL,
  pid                   INTEGER,                     -- current/last
  tmux_session          TEXT,
  tmux_window           TEXT,
  tmux_pane             TEXT,
  host                  TEXT NOT NULL,
  project               TEXT,                        -- null in MVP; reserved for per-project tmux placement
  parent_session_id     TEXT,                        -- null in MVP; reserved for orchestration
  start_ts              TEXT NOT NULL,
  last_heartbeat_ts     TEXT,
  end_ts                TEXT,
  exit_code             INTEGER,
  signal                TEXT,                        -- e.g. 'SIGTERM'
  status                TEXT NOT NULL                -- 'idle' | 'running' | 'waiting' | 'ended' | 'lost'
);
CREATE INDEX idx_sessions_status  ON sessions(status);
CREATE INDEX idx_sessions_project ON sessions(project);
```

### 4.2 Status semantics

Status is a projection of the event stream — no explicit `session.status_changed` event. Five values, three live + two terminal:

| Status | Meaning | Driven by |
|---|---|---|
| `idle` | Session is alive; agent is not currently in an active turn. The default live state. | `session.started` / `session.resumed`; heartbeat fresh (<60s). |
| `running` | Agent is actively processing a turn (LLM call, tool execution, code edits). | Adapter-emitted `turn.started`; cleared on `turn.ended` → back to `idle`. **Never set in MVP** (no adapters). |
| `waiting` | Agent is blocked on user input — question prompt, permission gate, MCP confirmation, etc. | Adapter-emitted `input.required`; cleared on `input.received` → back to `idle` or `running`. **Never set in MVP**. |
| `ended` | `session.ended` event received. Terminal. |  |
| `lost` | Started, no `session.ended`, no heartbeat in >60s. Computed lazily on `SELECT` against `sessions` (no background sweeper). | |

Live ↔ live transitions (`idle ↔ running ↔ waiting`) are reachable post-adapter without any schema change — the projection just observes new event kinds and updates the column. The event-kind names above (`turn.started`, `turn.ended`, `input.required`, `input.received`) are reserved here as the intended contract; their payloads are finalized when `@agmux/adapters` lands.

In MVP, every live wrapper session is `idle` throughout its life until `ended` or `lost`. The CLI displays all five values so that the moment adapters emit signals, the distinction shows up without any client change.

### 4.3 Event kinds (MVP)

All payloads JSON. Unknown kinds (from future versions) are stored raw and ignored by the projection — never dropped.

| Kind | Emitter | Payload (in addition to envelope) |
|---|---|---|
| `session.started` | wrapper | `agent_kind, profile, command, args, env_overrides, cwd, pid, tmux_{session,window,pane}, project` |
| `session.heartbeat` | wrapper | `pid_alive, winsize:{rows,cols}` |
| `session.resumed` | wrapper (when launched with parent-set `AGMUX_SESSION_ID`) | `new_pid, new_tmux_{session,window,pane}, reason:'cli_attach_after_death'` |
| `session.ended` | wrapper | `exit_code, signal?, reason:'normal'\|'signal'\|'pane_closed'` |

**Envelope** (every event): `{ event_id, ts, session_id, kind, version, host, payload }`.

### 4.4 Identity & resume semantics

- Per foundation §5: canonical `session_id` minted at first spawn; `AGMUX_SESSION_ID` is ground truth and is propagated by every integration.
- CLI `attach`'s dead-session-relaunch path sets `AGMUX_SESSION_ID=<old>` before invoking the wrapper. The wrapper emits `session.resumed` (not `session.started`); the projection updates mutable cols (`pid`, `tmux_*`, `last_heartbeat_ts`, `status←'idle'`, `end_ts←null`) while leaving immutables (`start_ts`, `agent_kind`, `profile`, original `command`) intact.
- **MVP gap:** with `native_session_id` unset and no adapters, the relaunch cannot pass the agent's native resume flag. The MVP relaunch therefore starts a *fresh* agent conversation under the same agmux `session_id`. Tracking is continuous; in-agent state is lost. Closing this gap is the first job of `@agmux/adapters`.

### 4.5 Config

`~/.config/agmux/config.toml`:

```toml
[profiles.claude-work]
agent_kind = "claude"
command = "ccc"
args = []
env = { ANTHROPIC_LOG = "info" }
# resume_template populated once adapters land; ignored in MVP

[profiles.claude-private]
agent_kind = "claude"
command = "cc"
args = []

[profiles.codex-default]
agent_kind = "codex"
command = "codex"
args = []
```

State directory: `~/.agmux/` — holds `agmux.sqlite`, `hub.pid`, `hub.port`, `queue/`.

---

## 5. CLI (`@agmux/cli`)

`agmux` is the user-facing binary. All non-`run` verbs are thin wrappers over the hub's HTTP query API + (for `attach`/`kill`) direct tmux calls.

### 5.1 Verbs

| Verb | Behavior |
|---|---|
| `agmux run <profile>` | Ensures hub is up (auto-spawn if not). Execs `agmux-wrap` with the resolved profile. Control transfers immediately into the agent (with tmux interposed when not already in tmux). |
| `agmux ls [--all] [--agent <kind>] [--profile <name>]` | Default lists live sessions (`status in (idle, running, waiting)`); `--all` includes `ended`/`lost`. Tabular: `id  agent  profile  status  pid  tmux  start  last_seen`. Short id = first 8 chars of UUIDv7; unambiguous prefixes accepted. |
| `agmux attach <id\|prefix>` | `GET /sessions/:id`. If status is live (`idle`/`running`/`waiting`) and tmux coords present: `tmux switch-client -t <session>:<window>` (from inside tmux) or `tmux attach -t <session>` and auto-select-window (from outside). If `status='ended'` or `'lost'`: re-exec `agmux-wrap` with `AGMUX_SESSION_ID=<id>` set → resume path (§4.4). |
| `agmux kill <id\|prefix> [--signal SIGTERM]` | Reads pid from projection, sends signal. Default SIGTERM. Wrapper handler emits `session.ended { reason:'signal', signal }` before exit. |
| `agmux inspect <id\|prefix>` | `GET /sessions/:id`. Pretty-printed row + last N events. Debug-oriented. |

`run` does not require the hub to be reachable to start — the write-through queue covers a still-booting hub. The other verbs require the hub and fail loudly if it can't be brought up.

### 5.2 Write-through queue

When the wrapper can't `POST /ingest` (connection refused / timeout / 5xx):
- Append the event as one JSON line to `~/.agmux/queue/<session_id>.jsonl`.
- Continue. Never block the agent on hub availability.
- Wrapper retries flushing its own queue file every 10s; deletes on full flush.
- On hub startup, hub also drains any files left behind by wrappers that exited before flushing. Idempotency: each event carries an `event_id` (ULID) and `/ingest` is unique-indexed on it — double-delivery is harmless.

### 5.3 Failure modes (explicit)

| Scenario | Behavior |
|---|---|
| Hub down at `agmux run` | Wrapper auto-spawns hub; if spawn fails, wrapper continues and queues. |
| Hub down mid-session | Wrapper queues; periodic retry; hub catches up on next start. |
| Wrapper SIGKILL | No `session.ended`. Heartbeat stops. Projection marks `lost` on next read (>60s gap). |
| Tmux pane closed | Wrapper gets SIGHUP → emits `session.ended { reason:'pane_closed' }`. |
| SQLite locked / corrupted | Hub returns 5xx on ingest; wrapper queues. Corruption recovery is out of MVP scope. |
| Two `agmux run` racing to spawn hub | Pidfile + atomic `hub.port` rename + `/health` check; loser sees a live hub and exits without spawning. |
| Profile not found | `agmux run` fails before any wrapper / hub interaction. Exit 2. |

### 5.4 Concurrency

- Hub is the only writer to SQLite. WAL mode permits concurrent readers, but CLI goes through the hub's HTTP API, so this is moot in MVP.
- `bun:sqlite` is synchronous; `Bun.serve()` handles each request on the main loop. For MVP load (one user, single-digit concurrent sessions, ~1 heartbeat/30s/session) this is over-provisioned. No worker thread, no connection pool.

---

## 6. Forward-compatibility commitments

Concrete choices made so future packages slot in without schema or contract changes:

- **`AGMUX_SESSION_ID` is the only identity contract.** Adapters, comms, future MCP surfaces all stamp their events with the env-injected id.
- **Append-only event log with versioned + raw-stored unknown kinds** absorbs new event types (prompt.sent, tool.used, token.usage, message.sent, …) without migration.
- **`running`/`waiting` status values exist in the projection enum from day one.** Adapters emitting `turn.started` / `turn.ended` / `input.required` / `input.received` flip the column; no schema change, no client change.
- **`project` and `parent_session_id` columns exist now**, null in MVP. The first user of either (per-project tmux placement; subagent spawning) adds behavior, not schema.
- **`resume_template` reserved in the profile config schema.** Wrapper ignores it; adapters will read it.
- **Single HTTP/JSON server**, no UDS, no special-case ingest transport — the same binary is the host-agent role under (B).
- **Wrapper package isolated** from store/hub — Go rewrite path stays open.

---

## 7. Open items (settled during implementation, not in this spec)

1. **Re-exec into a tmux window — exact mechanic.** Options include `tmux new-window … 'agmux-wrap-inner …'`, `tmux new-window …` then `tmux respawn-pane …`, or fork-exec the wrapper inside the window. The PTY/tty handoff needs validation; the spike covered the PTY half but not the "wrapper IS the pane content" half. Implementation will pick the working approach.
2. **Linux PTY portability.** Spike is darwin-only. The wrapper package must detect platform at runtime, `dlopen` libutil/libc on linux, and use the linux `TIOCSWINSZ`. Implementation budgets a portability sub-task and a linux CI runner.
3. **Heartbeat cadence (30s) and lost-threshold (2×)** — defaulted; revisit if noisy or laggy.
4. **CLI table formatting** — aesthetics, not architecture; settled in implementation.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| `bun build --compile` regression breaks wrapper packaging | Spike's `~63MB` binary is the reference. CI runs the compiled binary through the full PTY matrix on every PR. |
| Linux PTY work delays MVP | If linux blocks >1 week, fall back to macOS-only MVP and add Linux as first post-MVP task. Tracked as an explicit slip, not a silent one. |
| tmux version differences (2.x vs 3.x, popup support, etc.) | MVP targets tmux ≥3.2. Older versions warned-and-refused. |
| Hub auto-spawn race or zombie hubs | Pidfile + atomic port-file rename + `/health` check covers the race; stale pidfile cleanup on next spawn covers zombies. |
| `bun:sqlite` performance ceiling | For MVP load it is vastly over-provisioned. If it ever bottlenecks, the `@agmux/store` interface is the only thing that needs changing. |

---

## 9. Foundation alignment (sanity check)

| Standing principle (foundation §14) | Honored by MVP? |
|---|---|
| 1. localhost-only; no public surface | Hub binds 127.0.0.1 only; no auth. |
| 2. Canonical id via `AGMUX_SESSION_ID`; nothing invents identity | Wrapper mints + injects; CLI relaunch reuses; no other code path mints. |
| 3. Event log is truth; projections derived & rebuildable; one unified DB | `events` + `sessions` in one SQLite DB; `--rebuild-projections` provided. |
| 4. (B) is never designed out | Same HTTP/JSON server, `host` on every event, no UDS lock-in. |
| 5. tmux is a first-class orchestration substrate | Wrapper bootstraps tmux; `attach` drives tmux directly. |
| 6. Each consumer package optional; foundation small | Foundation here = `protocol + store + hub + wrapper`. `cli` joins as the smallest possible management surface. |
| 7. Event schema evolves additively; unknown events stored raw | Unique `event_id`, per-kind `version`, unknown kinds stored raw. |
| 8. `agent_kind` and `profile` distinct, both first-class | Both columns indexed; both filterable in `/sessions`. |
| 9. Comms messages are events; delivery is subscribe/MCP, never injection | N/A in MVP (no comms); model leaves room. |
