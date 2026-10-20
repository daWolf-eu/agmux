# Remote Sandbox Sessions — Phase 1 (visibility) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions recorded by an agmux hub inside OpenShell sandboxes are replicated into the Mac hub and show up in `ls`, `watch`, `dash`, the status line and notifications. You can filter them with `--remote` / `--local` / `--host`, and they can't be attached to or killed by mistake.

**Architecture:** Topology S (spec §5). Each sandbox runs plain agmux. It stamps `host` from `AGMUX_HOST` and exports its own log with `agmux events --follow`, starting from a rowid cursor. The Mac hub runs a sync loop: it discovers sandboxes (`openshell sandbox list`), keeps one follower `openshell … exec --no-tty` per sandbox, validates each streamed event, and stores it with `Store.appendReplicated`. Sync bookkeeping is itself log-derived (`host.*` events → `hosts` projection). Readers (`ls`/`dash`/status line/notifyd) only query the Mac hub, as today.

**Tech Stack:** Bun ≥ 1.3, TypeScript, `bun:sqlite`, `bun:test`, `smol-toml`, OpenTUI (dash), tmux.

**Spec:** [`docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md`](../specs/2026-10-08-remote-sandbox-sessions-design.md) (§4, §5, §9, §10 Phase 1). Spike: [`docs/spikes/2026-10-11-remote-sandbox/SPIKE_REPORT.md`](../../spikes/2026-10-11-remote-sandbox/SPIKE_REPORT.md).

## Global Constraints

- Foundation §14 holds: hub binds `127.0.0.1` only; event log is truth (projections rebuildable via `--rebuild-projections`); schema evolves additively, unknown kinds stored raw; nothing invents session identity.
- Remote host name: `AGMUX_HOST` overrides `os.hostname()` everywhere agmux stamps `host`.
- Cursor = remote `events.id` (rowid), never `ts`. Replication is **pull only**, Mac → remote via the transport.
- Follower spawn: `openshell -g <gw> sandbox exec -n <sbx> --no-tty -- <agmux> events --follow --after <cursor> --consumer <id>` with **stdin a pipe that is never closed** (spike: closing stdin orphans the remote side).
- Loop prevention: a node exports only events it ingested itself (`events.source IS NULL`).
- Replicated events are untrusted: validate like ingest (`validateEnvelope` + `validateKnownPayload`), never execute or shell-interpolate anything from them.
- `session.seen` is Mac-local; never sent back.
- Stale = sync failing for more than 3 × `interval`; it's a read-time overlay, never an invented session event.
- Removed sandbox → `host.removed`; live rows on a removed host derive to `lost`, rule `host-removed`; history is kept.
- Replication header: `{replication, agmux, db_id, host}`; the Mac accepts any `replication` ≤ its own, syncs newer ones best-effort and flags them.
- `[[remote]]` defaults: `transport = "openshell"`, `selector = "agmux=1"`, `interval = 5` (seconds).
- Keep `bun run typecheck` and `bun test` green; bump `packages/protocol/src/version.ts` + `CHANGELOG.md` for user-visible changes; document new mechanisms in the package `AGENTS.md`.

## Decisions this plan makes (spec gaps / inconsistencies)

1. **Host naming is discovery's job.** OpenShell discovery yields `host = <gateway>/<sandbox>` (§4.1). `[[remote]].name` is only the config/display key. This resolves the clash between §4.1 (`openshell/scratch`) and §4.8 (`<remote>/<node>`): the launcher knows the gateway, not the Mac's config name.
2. **Poll fallback = follower reconnect with exponential backoff** (`interval` → 300 s cap). Every reconnect catches up from the cursor, so a separate poll mode adds nothing.
3. **`host.*` events** use `session_id = NO_SESSION_ID` (nil UUID) and `host = <subject host>`.
4. **Remote rows are read-only on the Mac in Phase 1.** The query layer nulls `pid` and `tmux_*` for remote rows (stored events stay verbatim), and `attach`/`resume`/`kill` refuse them. Without this, `kill` would signal a *local* pid and attach/resume would act on local tmux panes or relaunch the agent on the Mac.
5. **Strict ingest of replicated events.** Reject when `host ≠ expected`, when `session_id` belongs to a row of another host, or when the kind is `host.*`. A header whose `host` differs fails the stream at once with an actionable error (most likely cause: `AGMUX_HOST` not set at sandbox create).
6. **`db_id`** (random, minted once per store in `_meta`) is in the header. A changed `db_id` (sandbox recreated under the same name) resets the cursor to 0.
7. **`dedup_key` is not replicated** (stored `NULL`): it was already applied remotely, and the Mac's dedup index is global.
8. **Cursor flush is debounced** (`host.synced` at most every 10 s, plus on stream end). Re-pulled events are idempotent on `event_id`.
9. **`agmux events --follow`** polls the local hub every 500 ms and writes a keepalive line after 15 s of silence. The Mac restarts a stream that has been silent for 60 s.
10. Dash: the `host` column is opt-in (not in `DEFAULT_COLUMNS`); key `r` cycles locality `all → local → remote` client-side.
11. **Out of scope here → separate homelab plan:** `stage-agmux`, the git-ignored build context, Dockerfile `COPY`, the Ansible assert + image prune, and launcher changes (`--label agmux=1`, `--env AGMUX_HOST=…`, `agmux adapter install`).

## Review Focus

1. **Sandbox created without `AGMUX_HOST`** (every existing sandbox): nothing replicates, and `hub status` / `inspect` must say why, naming the expected value. → Task 9 test `host mismatch fails fast with an actionable error`.
2. **Sandbox deleted and recreated under the same name**: the Mac cursor is ahead of the new log. Without a reset, the new sandbox is silently invisible. → Task 9 test `db_id change restarts from cursor 0`.
3. **Mac sleeps / gateway drops the stream mid-flight**: the stream must be restarted and catch up with no duplicates and no gaps. → Task 9 tests `silent stream is restarted by the watchdog`, `reconnect resumes from the last flushed cursor`.
4. **`kill` / attach / status-line click on a remote row**: must never touch a local pid or pane. → Task 12 tests.
5. **Remote and local pane id collision** (`%3` exists on both): focus-seen, notifyd title polling and dash mirror must not cross over. → Task 3 test `remote rows expose no pid or tmux coords`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/protocol/src/host.ts` (new) | `AGMUX_HOST` resolution, `NO_SESSION_ID`, host-event payloads, `HostRow`, `TransportSpec`, replication wire types + `REPLICATION_VERSION` |
| `packages/protocol/src/session.ts` | `SessionRow` remote fields, `Locality`, `StatusRule` `host-removed` |
| `packages/store/src/schema.ts`, `migrations.ts` | V9: `events.source`, `hosts`, `_meta.db_id` |
| `packages/store/src/hosts.ts` (new) | `host.*` projection + `getHost` / `listHosts` |
| `packages/store/src/index.ts` | `appendReplicated`, `listExportable`, `dbId`, rebuild includes `hosts` |
| `packages/store/src/queries.ts`, `lost.ts` | hosts join, masking, `host`/`locality` filters, `host-removed` rule |
| `packages/hub/src/server.ts` | `/events?after_id`, `/sessions?host&locality`, `/hosts`, `/health.db_id` |
| `packages/hub/src/sync/config.ts` (new) | `[[remote]]` parsing |
| `packages/hub/src/sync/transport.ts` (new) | `Transport` interface + openshell impl |
| `packages/hub/src/sync/discovery.ts` (new) | `Discovery` interface + openshell `sandbox list` impl |
| `packages/hub/src/sync/ingest.ts` (new) | stream-line parsing + validation of replicated events |
| `packages/hub/src/sync/follower.ts` (new) | one per-sandbox follower process: cursor, reconnect, watchdog |
| `packages/hub/src/sync/sync-loop.ts` (new) | discovery cycle, follower set, host ledger (`host.*` events) |
| `packages/hub/bin/agmux-hub.ts` | wire `startSync` |
| `packages/cli/src/events-cmd.ts` (new) | `agmux events [--follow] --after <n> [--consumer <id>] [--limit <n>]` |
| `packages/cli/src/remote-guard.ts` (new) | refusal message for remote rows |
| `packages/cli/src/parse-ls.ts`, `ls.ts`, `parse-dash.ts`, `dash.ts`, `wrapper/src/profile.ts` | `--remote/--local/--host`, `[ls]/[dash] locality` |
| `packages/tui/src/shared/locality.ts` (new), `columns.ts`, `format.ts`, `statusline.ts`, `opentui/*` | host column, locality key, stale marker, `⇄` chip prefix |
| `tests/e2e/remote-sync.test.ts` + `tests/e2e/fake-openshell.sh` (new) | Mac hub ↔ "sandbox" end to end without OpenShell |

---

### Task 1: `AGMUX_HOST` host resolution

**Files:**
- Create: `packages/protocol/src/host.ts`, `packages/protocol/tests/host.test.ts`
- Modify: `packages/protocol/src/env.ts`, `packages/protocol/src/index.ts`, `packages/cli/bin/agmux.ts` (5 × `os.hostname()`), `packages/cli/src/headless.ts:60`, `packages/wrapper/src/index.ts:44`, `packages/hub/bin/agmux-hub.ts:43`

**Interfaces:**
- Produces: `AGMUX_HOST_ENV = "AGMUX_HOST"` (env.ts); `resolveHost(env?: Record<string,string|undefined>, hostname?: string): string` and `isValidHostName(s: string): boolean` (host.ts). Valid = `/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/`, ≤ 255 chars.

- [ ] **Step 1: Write failing tests** in `host.test.ts`:
  - `resolveHost({ AGMUX_HOST: "ai-sandbox/wi-sag-280" }, "144190573f15")` → `"ai-sandbox/wi-sag-280"`
  - `resolveHost({}, "mac.local")` → `"mac.local"`; `resolveHost({ AGMUX_HOST: "" }, "mac.local")` → `"mac.local"`
  - invalid `AGMUX_HOST` (`"a b"`, `"a/b/c"`, `"../x"` is valid chars but `"a/../b"` has 2 slashes → invalid) → falls back to hostname
- [ ] **Step 2:** `bun test packages/protocol/tests/host.test.ts` → FAIL (module not found)
- [ ] **Step 3:** Implement `host.ts`; defaults are `process.env` and `os.hostname()`. Replace every listed `os.hostname()` call site with `resolveHost()`. The hub's liveness sweep must use the same resolved host as `emit`, or in-sandbox sessions are never swept.
- [ ] **Step 4:** `bun test packages/protocol packages/hub packages/cli && bun run typecheck` → PASS
- [ ] **Step 5:** Commit `feat(protocol): AGMUX_HOST overrides the stamped host`

---

### Task 2: Store — replication write side and `hosts` projection

**Files:**
- Modify: `packages/protocol/src/host.ts`, `packages/protocol/src/events.ts` (kinds list), `packages/store/src/schema.ts`, `packages/store/src/migrations.ts`, `packages/store/src/index.ts`, `packages/store/src/project.ts` (dispatch `host.*`)
- Create: `packages/store/src/hosts.ts`, `packages/store/tests/replication.test.ts`, `packages/store/tests/hosts.test.ts`

**Interfaces:**
- Produces (protocol `host.ts`):
  ```ts
  export const NO_SESSION_ID = "00000000-0000-0000-0000-000000000000";
  export const EVENT_KINDS_HOST = ["host.synced", "host.sync_failed", "host.removed"] as const;
  export interface TransportSpec { kind: "openshell"; gateway: string; target: string; bin: string }
  export interface HostSyncedPayload { remote: string; transport: TransportSpec; cursor: number; db_id: string; agmux_version: string; replication: number; rejected: number }
  export interface HostSyncFailedPayload { remote: string; error: string }
  export interface HostRemovedPayload { remote: string }
  export interface HostRow { host: string; remote: string; transport: TransportSpec | null; last_sync_ts: string | null; last_sync_ok: boolean; last_error: string | null; cursor: number; db_id: string | null; agmux_version: string | null; replication: number | null; rejected: number; removed_ts: string | null }
  export const REPLICATION_VERSION = 1;
  export interface ReplicationHeader { replication: number; agmux: string; db_id: string; host: string }
  export interface ReplicationRecord { id: number; ev: EventEnvelope }
  ```
- Produces (store): `Store.appendReplicated(ev: EventEnvelope, source: string): boolean`, `Store.listExportable(afterId: number, limit: number): { records: ReplicationRecord[]; last_id: number }`, `Store.dbId(): string`, `Store.getHost(host: string): HostRow | null`, `Store.listHosts(): HostRow[]`.

Schema V9:
```sql
ALTER TABLE events ADD COLUMN source TEXT;          -- replicated-in from this host; NULL = ingested here
CREATE TABLE IF NOT EXISTS hosts (
  host TEXT PRIMARY KEY, remote TEXT NOT NULL, transport TEXT,
  last_sync_ts TEXT, last_sync_ok INTEGER NOT NULL DEFAULT 1, last_error TEXT,
  cursor INTEGER NOT NULL DEFAULT 0, db_id TEXT, agmux_version TEXT, replication INTEGER,
  rejected INTEGER NOT NULL DEFAULT 0, removed_ts TEXT
);
```
Projection: `host.synced` upserts every field, sets `last_sync_ok = 1`, `last_error = NULL`, `removed_ts = NULL`, `last_sync_ts = ev.ts`. `host.sync_failed` upserts `last_sync_ok = 0`, `last_error`. `host.removed` sets `removed_ts = ev.ts`. Key: `ev.host`.

- [ ] **Step 1: Write failing tests** (`replication.test.ts`):
  - `appendReplicated stores source and applies the projection`: a `session.registered` with host `gw/sbx` → `getSession` exists; the raw `events.source` is `"gw/sbx"`.
  - `appendReplicated is idempotent on event_id`: the second call returns `false`; the event count is unchanged.
  - `appendReplicated drops dedup_key`: the stored `dedup_key IS NULL` even when the input had one.
  - `listExportable excludes replicated rows`: 2 local + 1 replicated → 2 records, `last_id` = id of the second local row; `listExportable(last_id, 10)` → `{records: [], last_id}` (unchanged cursor).
  - `listExportable honours limit`: 5 local, limit 2 → ids 1,2 then `after=2` → 3,4.
  - `dbId is stable across reopen and differs between stores` (file-backed temp DB; reopen → same id).
  (`hosts.test.ts`):
  - `host.synced → host.sync_failed → host.synced` toggles `last_sync_ok` and clears `last_error`.
  - `host.removed then host.synced clears removed_ts`.
  - `rebuildProjections rebuilds hosts` (delete + replay gives an equal `listHosts()`).
- [ ] **Step 2:** `bun test packages/store/tests/replication.test.ts packages/store/tests/hosts.test.ts` → FAIL
- [ ] **Step 3:** Implement V9, `hosts.ts` (`applyHostEvent(db, ev)`, `getHost`, `listHosts`), and the `Store` methods. `appendReplicated` uses `INSERT … ON CONFLICT(event_id) DO NOTHING` and **does not** re-apply `session.registered` on a duplicate. `dbId()` reads `_meta.db_id`, minting `crypto.randomUUID()` on first use inside an IMMEDIATE transaction. `rebuildProjections` also clears `hosts`. Add `EVENT_KINDS_HOST` to `KnownEvent` typing (payload validators for `host.*` are not needed: only the hub writes them).
- [ ] **Step 4:** `bun test packages/store && bun run typecheck` → PASS (incl. `migrations.test.ts` target version 9)
- [ ] **Step 5:** Commit `feat(store): appendReplicated, exportable cursor and hosts projection`

---

### Task 3: Store — remote rows on the read side

**Files:**
- Modify: `packages/protocol/src/session.ts`, `packages/store/src/queries.ts`, `packages/store/src/lost.ts`
- Create: `packages/store/tests/remote-rows.test.ts`

**Interfaces:**
- Consumes: `hosts` table (Task 2).
- Produces:
  - `SessionRow` gains `remote?: boolean; sync_stale?: boolean; last_sync_ts?: string | null`.
  - `export type Locality = "local" | "remote"` (session.ts).
  - `StatusRule` gains `"host-removed"`.
  - `ListSessionsOpts` gains `host?: string` (SQLite `GLOB` on `s.host`) and `locality?: Locality`.
  - `RowForDerive` gains `host_removed_ts?: string | null`.

`ROW_SELECT` adds `LEFT JOIN hosts h ON h.host = s.host` selecting `h.host AS remote_host, h.last_sync_ok, h.last_sync_ts, h.removed_ts AS host_removed_ts`. A row is remote iff `remote_host` is not null. For remote rows `decodeRow` sets `pid`, `tmux_session`, `tmux_window`, `tmux_pane`, `tmux_socket` to `null` (Decision 4). `deriveStatus`: right after the terminal rule, a live row with `host_removed_ts` → `{status: "lost", rule: "host-removed", reason: "host <h> removed at <ts>"}`.

- [ ] **Step 1: Write failing tests** (`remote-rows.test.ts`, rows built with `appendReplicated` + `host.synced` events):
  - `remote rows are flagged`: `remote === true`, `sync_stale === false`; a local row has `remote === false`.
  - `remote rows expose no pid or tmux coords`: a replicated `session.registered` with `pid: 42, tmux_pane: "%3"` → `pid === null`, `tmux_pane === null`; the raw event payload is unchanged (`listEvents`).
  - `sync_failed marks rows stale` → `sync_stale === true`, status unchanged.
  - `host.removed derives lost with rule host-removed` (`explainSession(...).rule === "host-removed"`); an ended row stays `ended`.
  - `listSessions locality and host filters`: `{locality: "remote"}` → only remote; `{locality: "local"}` → only local; `{host: "gw/*"}` → only `gw/…` rows.
  - `liveness candidates exclude remote rows`: `listLiveNativeSessions("mac.local")` never returns a `gw/sbx` row (regression guard for the sweep).
- [ ] **Step 2:** `bun test packages/store/tests/remote-rows.test.ts` → FAIL
- [ ] **Step 3:** Implement the join, masking, filters (`s.host GLOB ?`, `remote_host IS [NOT] NULL`) and the rule. New WHERE clauses must qualify `s.host` (the join makes `host` ambiguous).
- [ ] **Step 4:** `bun test packages/store packages/hub && bun run typecheck` → PASS
- [ ] **Step 5:** Commit `feat(store): remote rows — stale overlay, host-removed rule, locality filters`

---

### Task 4: Hub HTTP surface

**Files:**
- Modify: `packages/hub/src/server.ts`
- Test: `packages/hub/tests/server.test.ts`

**Interfaces:**
- Consumes: Task 2/3 store methods.
- Produces:
  - `GET /events?after_id=<n>&limit=<m>` (`limit` default 500, max 5000) → `{ records: ReplicationRecord[], last_id: number }`; exportable rows only. The legacy `/events` (no `after_id`) is unchanged.
  - `GET /sessions?host=<glob>&locality=local|remote` (other value → 400 `invalid_locality`).
  - `GET /hosts` → `{ hosts: HostRow[] }`.
  - `GET /health` adds `db_id`.

- [ ] **Step 1: Write failing tests:** `/events?after_id=0` returns records in id order with `last_id`; `after_id=abc` → 400 `invalid_after_id`; `/sessions?locality=remote` filters; `locality=x` → 400; `/hosts` lists a host after a `host.synced` append; `/health.db_id` equals `store.dbId()`.
- [ ] **Step 2:** `bun test packages/hub/tests/server.test.ts` → FAIL
- [ ] **Step 3:** Implement the routes.
- [ ] **Step 4:** `bun test packages/hub` → PASS
- [ ] **Step 5:** Commit `feat(hub): cursor export, hosts and locality query params`

---

### Task 5: `agmux events` (the remote side of replication)

**Files:**
- Create: `packages/cli/src/events-cmd.ts`, `packages/cli/tests/events-cmd.test.ts`
- Modify: `packages/cli/bin/agmux.ts` (verb `events`, after the `ensureHubRunning` gate), `packages/cli/src/usage.ts`

**Interfaces:**
- Consumes: `GET /events?after_id`, `GET /health` (`db_id`), `resolveHost`, `REPLICATION_VERSION`, `AGMUX_VERSION`.
- Produces: `parseEventsArgs(argv: string[]): { kind: "ok"; follow: boolean; after: number; consumer: string | null; limit: number } | { kind: "error"; message: string }`; `eventsCmd(opts, deps: { fetchImpl; write(line: string): boolean; sleep(ms): Promise<void>; nowMs(): number; host: string; stateDir: string; kill?; isAlive? }): Promise<number>`.
- Wire format (NDJSON on stdout, one JSON object per line):
  1. a header `{"replication":1,"agmux":"<ver>","db_id":"<id>","host":"<resolveHost()>"}`
  2. records `{"id":<rowid>,"ev":<EventEnvelope>}`
  3. `{"keepalive":"<iso ts>"}` after 15 000 ms without a record (`--follow` only)
- Constants: `FOLLOW_POLL_MS = 500`, `KEEPALIVE_MS = 15_000`.
- Consumer lock: `<stateDir>/follow/<consumer>.pid`. On start, a live pid ≠ self there → `SIGTERM` it, then write our pid; remove it on exit. `consumer` must match `/^[A-Za-z0-9._-]{1,64}$/`.

- [ ] **Step 1: Write failing tests** (fake hub via injected `fetchImpl`):
  - `parse`: `--after` required, a non-negative integer; `--limit` positive; `--consumer` charset; an unknown flag → error.
  - `one-shot drains until a short page`: 3 pages (500, 500, 7) → header + 1007 records, exit 0, cursor passed through `after_id`.
  - `follow emits keepalive after silence` (fake clock).
  - `follow exits 0 when write returns false / throws EPIPE`.
  - `consumer lock replaces a live previous follower` (`kill` called with its pid and `SIGTERM`; pid file now ours).
- [ ] **Step 2:** `bun test packages/cli/tests/events-cmd.test.ts` → FAIL
- [ ] **Step 3:** Implement. Hub unreachable mid-follow → exit 1 (the Mac reconnects; `ensureHubRunning` on the next exec restarts the hub).
- [ ] **Step 4:** `bun test packages/cli && bun run typecheck` → PASS
- [ ] **Step 5:** Commit `feat(cli): agmux events streams the exportable log by cursor`

---

### Task 6: `[[remote]]` config, transport and discovery

**Files:**
- Create: `packages/hub/src/sync/config.ts`, `transport.ts`, `discovery.ts`; tests `packages/hub/tests/sync-config.test.ts`, `sync-transport.test.ts`
- Modify: `packages/hub/package.json` (add `smol-toml`), `packages/hub/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RemoteConfig { name: string; transport: "openshell"; gateway: string; selector: string; interval: number; openshell_bin: string; agmux_bin: string }
  export function parseRemotes(raw: unknown): RemoteConfig[]          // raw = parsed TOML root's `remote`
  export function loadRemotes(configPath: string): RemoteConfig[]     // missing file/section → []
  export interface Transport { spec(target: string): TransportSpec; argv(target: string, cmd: string[], o: { tty: boolean }): string[] }
  export function openshellTransport(r: RemoteConfig): Transport
  export interface DiscoveredNode { target: string; host: string }
  export interface Discovery { list(): Promise<DiscoveredNode[]> }
  export function parseSandboxList(json: string, gateway: string): DiscoveredNode[]
  export function openshellDiscovery(r: RemoteConfig, run: (argv: string[]) => Promise<string>): Discovery
  ```
- Defaults: `transport "openshell"`, `selector "agmux=1"`, `interval 5`, `openshell_bin "openshell"`, `agmux_bin "agmux"`.
- Errors: `transport = "ssh"` → `[[remote]] "<name>": transport "ssh" is not supported yet`; duplicate `name`; `name` not `/^[A-Za-z0-9._-]+$/`; missing `gateway`; non-positive `interval`; unknown key.
- `argv(t, cmd, {tty:false})` = `[openshell_bin, "-g", gateway, "sandbox", "exec", "-n", t, "--no-tty", "--", ...cmd]` (`--tty` when `tty`).
- `openshellDiscovery.list()` runs `[openshell_bin, "-g", gateway, "sandbox", "list", "-o", "json", "--selector", selector]`; `host = ${gateway}/${name}` (Decision 1). Entries whose name fails `isValidHostName` are skipped.

- [ ] **Step 1: Write failing tests:** the default fill-in; each error above; the exact argv for both tty modes; `parseSandboxList` on the spike's JSON shape (`[{name, id, phase, labels:{agmux:"1"}, …}]`) → `[{target:"wi-sag-280", host:"ai-sandbox/wi-sag-280"}]`; invalid JSON → throws.
- [ ] **Step 2:** `bun test packages/hub/tests/sync-config.test.ts packages/hub/tests/sync-transport.test.ts` → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun test packages/hub && bun run typecheck` → PASS
- [ ] **Step 5:** Commit `feat(hub): [[remote]] config, openshell transport and discovery`

---

### Task 7: Validating replicated events

**Files:**
- Create: `packages/hub/src/sync/ingest.ts`, `packages/hub/tests/sync-ingest.test.ts`

**Interfaces:**
- Consumes: `Store.appendReplicated`, `validateEnvelope`, `validateKnownPayload`; adds `Store.sessionHost(sid: string): string | null` (`SELECT host FROM sessions WHERE session_id = ?`).
- Produces:
  ```ts
  export type StreamLine =
    | { type: "header"; header: ReplicationHeader }
    | { type: "record"; record: ReplicationRecord }
    | { type: "keepalive" }
    | { type: "invalid"; reason: string };
  export function parseStreamLine(line: string): StreamLine
  export type IngestOutcome = { ok: true; appended: boolean } | { ok: false; reason: string };
  export function ingestReplicated(store: Store, rec: ReplicationRecord, expectedHost: string): IngestOutcome
  export function checkHeader(h: ReplicationHeader, expectedHost: string): { ok: true; newer: boolean } | { ok: false; error: string }
  ```
- Reject reasons (exact prefixes, used in `last_error`): `host mismatch`, `foreign session`, `host event`, `invalid envelope`, `invalid payload`.
- `checkHeader` host mismatch error text: `sandbox stamps host "<h.host>", expected "<expected>" — create the sandbox with --env AGMUX_HOST=<expected>`.

- [ ] **Step 1: Write failing tests:**
  - `accepts a valid record and stores source = expectedHost`.
  - `rejects host mismatch` (`ev.host = "144190573f15"`).
  - `rejects an event naming a session of another host` (a local session row on `mac.local`, replicated event with the same `session_id` and host `gw/sbx` → `foreign session`; the local row is untouched).
  - `rejects host.* kinds`.
  - `rejects an invalid known payload` (e.g. `session.registered` without `native_session_id`).
  - `stores an unknown kind raw` (principle 7).
  - `parseStreamLine` on header / record / keepalive / garbage / a record missing `id`.
  - `checkHeader` mismatch text exact; `replication: 2` → `{ok: true, newer: true}`.
- [ ] **Step 2:** `bun test packages/hub/tests/sync-ingest.test.ts` → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun test packages/hub` → PASS
- [ ] **Step 5:** Commit `feat(hub): validate replicated events before appending`

---

### Task 8: Per-sandbox follower

**Files:**
- Create: `packages/hub/src/sync/follower.ts`, `packages/hub/tests/sync-follower.test.ts`

**Interfaces:**
- Consumes: `Transport`, `parseStreamLine`, `checkHeader`, `ingestReplicated`.
- Produces:
  ```ts
  export interface FollowerStatus { connected: boolean; cursor: number; dbId: string | null; header: ReplicationHeader | null; rejected: number; lastError: string | null; failingSinceMs: number | null; permanent: boolean }
  export interface Follower { status(): FollowerStatus; stop(): Promise<void> }
  export interface ProcHandle { lines: AsyncIterable<string>; kill(): void; exited: Promise<number> }
  export interface FollowerDeps { spawn(argv: string[]): ProcHandle; nowMs(): number; sleep(ms: number): Promise<void> }
  export function startFollower(o: {
    store: Store; node: DiscoveredNode; transport: Transport; agmuxBin: string; consumer: string;
    cursor: number; dbId: string | null; intervalMs: number;
    onChange(s: FollowerStatus): void;      // called on connect, cursor advance, error, header
  }, deps?: FollowerDeps): Follower
  ```
- The default `spawn`: `Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })`. **Keep `stdin` open and never write to or end it** (Global Constraints). `kill()` sends SIGTERM.
- Command: `[agmuxBin, "events", "--follow", "--after", String(cursor), "--consumer", consumer]`.
- Constants: `IDLE_TIMEOUT_MS = 60_000`, `MAX_BACKOFF_MS = 300_000`.
- Behaviour:
  - First line not a header → error `no replication header`.
  - `checkHeader` fails → `permanent = true`, `lastError` = the error, retry at `MAX_BACKOFF_MS`.
  - Header `db_id` ≠ known `dbId` while `cursor > 0` → kill and respawn with `--after 0`.
  - Each record → `ingestReplicated`; cursor = `record.id` whether or not the record was accepted; rejected ones increment `rejected` and set `lastError`.
  - Process exit or idle timeout → reconnect after a backoff: `intervalMs`, doubling per consecutive failure up to `MAX_BACKOFF_MS`, reset when a header arrives.
  - `failingSinceMs` = time of the first failure since the last header.

- [ ] **Step 1: Write failing tests** (fake `spawn` yielding scripted lines; fake clock):
  - `streams records and advances the cursor`.
  - `reconnect resumes from the last cursor` (2nd spawn argv has `--after <last id>`).
  - `silent stream is restarted by the watchdog` (no line for 60 s → `kill` called, respawn).
  - `backoff doubles to the cap and resets after a header`.
  - `host mismatch fails fast with an actionable error` (`permanent`, `lastError` contains `AGMUX_HOST=gw/sbx`, no records appended).
  - `db_id change restarts from cursor 0`.
  - `stdin is never closed`: the fake `spawn` asserts the default spawn options (`stdin: "pipe"`); separately, a unit test of the default spawn with `bun -e "process.stdin.on('end',()=>console.log('EOF'))"` + a 300 ms wait sees no `EOF`.
  - `stop() kills the process and resolves`.
- [ ] **Step 2:** `bun test packages/hub/tests/sync-follower.test.ts` → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun test packages/hub` → PASS
- [ ] **Step 5:** Commit `feat(hub): per-sandbox replication follower`

---

### Task 9: Sync loop, host ledger, hub wiring

**Files:**
- Create: `packages/hub/src/sync/sync-loop.ts`, `packages/hub/tests/sync-loop.test.ts`
- Modify: `packages/hub/bin/agmux-hub.ts`, `packages/hub/src/index.ts`

**Interfaces:**
- Consumes: Tasks 6–8, `Store.getHost/listHosts/append`, `NO_SESSION_ID`.
- Produces: `startSync(o: { store: Store; remotes: RemoteConfig[]; consumer: string; log(s: string): void }, deps?: { discoveryFor?(r: RemoteConfig): Discovery; transportFor?(r: RemoteConfig): Transport; follower?: typeof startFollower; nowMs?(): number; newId?(): string }): () => Promise<void>` (returns stop).
- Constants: `CURSOR_FLUSH_MS = 10_000`, `STALE_AFTER_INTERVALS = 3`.
- Per remote, every `interval` s:
  1. Discovery fails → log once per distinct error, change nothing.
  2. For each new node → `startFollower` with `cursor`/`dbId` from `getHost(host)` (`removed` rows start at their stored cursor too).
  3. For a node gone from a successful listing whose host row (same `remote`) is not removed → stop its follower, append `host.removed`.
- Ledger, from `onChange` (envelope: `session_id = NO_SESSION_ID`, `host = node.host`, `kind = host.*`, ULID `event_id`, `dedup_key = null`):
  - `host.synced` when ok-state flips to ok, or when the cursor moved and ≥ `CURSOR_FLUSH_MS` passed since the last flush, and on follower stop.
  - `host.sync_failed` when `permanent`, or when `nowMs - failingSinceMs > STALE_AFTER_INTERVALS * interval * 1000`; once per distinct `lastError`.
- Hub bin: `loadRemotes(~/.config/agmux/config.toml)` in a try/catch; a config error → `console.error` and run without sync (never crash the hub). Consumer = `resolveHost()` with characters outside `[A-Za-z0-9._-]` replaced by `_`. Stop sync in `shutdown`.

- [ ] **Step 1: Write failing tests** (fake discovery, fake follower factory, fake clock):
  - `starts one follower per discovered node with the stored cursor`.
  - `node disappearing appends host.removed once and stops its follower`.
  - `discovery failure removes nothing`.
  - `cursor flush is debounced` (100 cursor changes within 10 s → 1 `host.synced`).
  - `sync_failed only after 3 intervals, then synced on recovery`.
  - `permanent error is reported immediately`.
  - `no remotes → no timers, stop resolves`.
- [ ] **Step 2:** `bun test packages/hub/tests/sync-loop.test.ts` → FAIL
- [ ] **Step 3:** Implement + wire the hub bin.
- [ ] **Step 4:** `bun test packages/hub && bun run typecheck` → PASS
- [ ] **Step 5:** Commit `feat(hub): sync loop replicates discovered sandboxes`

---

### Task 10: End-to-end replication without OpenShell

**Files:**
- Create: `tests/e2e/fake-openshell.sh`, `tests/e2e/remote-sync.test.ts`

**Interfaces:**
- Consumes: `makeTestEnv()` (`tests/e2e/helpers.ts`), `[[remote]] openshell_bin`, `agmux_bin`.
- `fake-openshell.sh` mimics the two verbs used. `-g <gw> sandbox list -o json --selector …` → `cat "$FAKE_OS_DIR/list.json"`. `-g <gw> sandbox exec -n <name> --no-tty -- <cmd…>` → `HOME=$FAKE_OS_DIR/<name> AGMUX_HOST=<gw>/<name> exec <cmd…>`; it ignores `--tty`. A name listed in `$FAKE_OS_DIR/nohost` gets no `AGMUX_HOST` (an old sandbox).

- [ ] **Step 1: Write the test** (two envs: `mac` and `sbx`; the sandbox's `agmux_bin` = the `sbx` env's CLI shim):
  - Post a `session.registered` (+ `turn.ended`) to the sandbox hub via `agmux emit`-equivalent `POST /ingest` with `AGMUX_HOST=gw/box1` set.
  - Mac config: `[[remote]] name="t" gateway="gw" interval=0.2 openshell_bin=<fake> agmux_bin=<sbx cli shim>`.
  - Within 10 s: `mac agmux ls --remote` lists the session with host `gw/box1`; `ls --local` doesn't.
  - Remove `box1` from `list.json` → within 5 s, `mac agmux explain <id> --json` shows rule `host-removed`.
  - A second sandbox `box2` listed in `nohost` → `GET /hosts` shows `last_sync_ok: false` and `last_error` containing `AGMUX_HOST`.
- [ ] **Step 2:** `bun test tests/e2e/remote-sync.test.ts` → it may already pass if Tasks 1–9 are right. If it fails, fix the cause in the owning task's files.
- [ ] **Step 3:** Commit `test(e2e): Mac hub replicates a sandbox hub through a fake openshell`

---

### Task 11: CLI filters and config defaults

**Files:**
- Modify: `packages/cli/src/parse-ls.ts`, `packages/cli/src/ls.ts`, `packages/wrapper/src/profile.ts` (`LsConfig`/`DashConfig` + parsers), `packages/cli/src/usage.ts`
- Test: `packages/cli/tests/parse-ls.test.ts`, `ls.test.ts`, `parse-dash.test.ts`, `packages/wrapper/tests/…` (wherever `parseLsSection` is tested)

**Interfaces:**
- Produces: `LsQueryOpts` gains `locality?: Locality; host?: string`. `LsConfig`/`DashConfig` gain `locality?: Locality` (config value `"all"` → `undefined`). `buildLsQuery` sets `locality` and `host`.

- [ ] **Step 1: Write failing tests:**
  - `--remote` → `locality: "remote"`; `--local` → `"local"`; both → error `ls: --remote and --local are mutually exclusive`.
  - `--host 'gw/*'` and `--host=gw/*` → `host: "gw/*"`; an empty value → error.
  - `[ls] locality = "remote"` is the default, and a flag overrides it; `locality = "x"` → throws `[ls] locality must be all|local|remote`.
  - `buildLsQuery` → `locality=remote&host=gw%2F*`.
  - watch and dash inherit the flags (`parseWatchArgs(["--remote"])`).
- [ ] **Step 2:** Run the four test files → FAIL
- [ ] **Step 3:** Implement; update `HELP_TEXT`.
- [ ] **Step 4:** `bun test packages/cli packages/wrapper` → PASS
- [ ] **Step 5:** Commit `feat(cli): --remote, --local and --host filters`

---

### Task 12: Remote rows are read-only on the Mac

**Files:**
- Create: `packages/cli/src/remote-guard.ts`
- Modify: `packages/cli/src/attach.ts` (`attachCmd`), `packages/cli/src/dash-actions.ts` (`attach`, `resume`, `kill`), `packages/cli/src/kill.ts`, `packages/tui/src/shared/attach-targets.ts` (`attachKind`)
- Test: `packages/cli/tests/remote-guard.test.ts`, `attach.test.ts`, `dash-actions.test.ts`, `packages/tui/tests/shared/attach-targets.test.ts`

**Interfaces:**
- Produces: `remoteRefusal(row: Pick<SessionRow, "remote" | "host" | "session_id">, verb: "attach" | "resume" | "kill"): string | null`. Message: `<verb>: <id8> runs on <host>; remote <verb> is not supported yet`. `attachKind(row)` returns `"none"` for remote rows. That keeps the dash's ⏎ and `A` popup inert, and `attach-placed` already errors on `"none"`.

- [ ] **Step 1: Write failing tests:**
  - `attachCmd on a remote row prints the refusal, returns 2, never calls tmux or Bun.spawn` (inject via the existing test seams in `attach.test.ts`).
  - `makeActions().resume(remoteRow)` rejects with the refusal; `kill(remoteRow)` never calls `process.kill` (spy).
  - `killCmd on a remote row` → refusal, exit 2. This covers rows from an old hub that still exposes `pid`, as defense in depth next to the Task 3 masking.
  - `attachKind({...live, remote: true})` → `"none"`.
  - Status-line click on a remote chip goes through `attachCmd` → refusal (assert via `statuslineClick` with a stub `attach` that records the call and the existing wiring test).
- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun test packages/cli packages/tui` → PASS
- [ ] **Step 5:** Commit `fix(cli): refuse attach, resume and kill on remote sessions`

---

### Task 13: Showing remote sessions (ls, dash, status line)

**Files:**
- Create: `packages/tui/src/shared/locality.ts`, `packages/tui/tests/shared/locality.test.ts`
- Modify: `packages/tui/src/shared/columns.ts`, `packages/tui/src/format.ts`, `packages/tui/src/shared/statusline.ts`, `packages/tui/src/opentui/DashApp.tsx`, `HeaderBar.tsx`, `FooterBar.tsx`, `Overlays.tsx` (help), `PreviewPane.tsx` (detail), `run-manage.tsx`, `packages/cli/src/dash.ts`
- Test: `packages/tui/tests/shared/columns.test.ts`, `format` tests, `statusline` tests, `tests/opentui/dash-app.test.tsx`, `packages/cli/tests/dash.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LocalityFilter = "all" | Locality;
  export const LOCALITY_CYCLE: LocalityFilter[] = ["all", "local", "remote"];
  export function nextLocality(l: LocalityFilter): LocalityFilter
  export function matchesLocality(r: SessionRow, l: LocalityFilter): boolean
  export function hostLabel(r: SessionRow): string   // "" local; "⇄ <part after first '/'>"; stale → "? <…>"
  ```
- `COLUMN_KEYS` appends `"host"` (header `HOST`, style `sub`, `max: 28`, `min: 8`, text `hostLabel`; not in `DEFAULT_COLUMNS`; add to `SHRINK_ORDER` before `name`).
- `RunManageOpts`/`DashAppProps` gain `initialLocality: LocalityFilter`. `dashCmd` passes `opts.locality ?? "all"` and **strips** `locality` from the group queries (the client filters, so cycling `r` can widen the view again). `host` stays server-side.
- Dash key `r` cycles locality. The header shows `local`/`remote` when the filter isn't `all`. Footer hint `[r] host` (drop priority after `f`). Help row `["r", "local/remote"]`.
- `formatTable` adds a `HOST` column (after `NAME`) only when some row is remote; local rows show `-`.
- Status line: in `chip()`, a remote row's `{name}` value is prefixed `⇄ ` (the prefix is counted by `fitLine` through `statusWidth`; `escapeStyles` still applies to the name).
- Detail preview: replace `["Host", r.host]` with `r.host` plus, for remote rows, ` · last sync <relTime(last_sync_ts)>` and ` · stale` when `sync_stale`.

- [ ] **Step 1: Write failing tests:** `hostLabel` for local / remote / stale; the cycle order; `matchesLocality`; `formatTable` without remote rows is byte-identical to before (snapshot of the current header) and with one remote row has a `HOST` column; the status-line chip for a remote row contains `⇄ ` before the name, and the width-fitting test still holds; dash render test: pressing `r` twice shows only remote rows; `dashCmd` group queries carry no `locality` but do carry `host`.
- [ ] **Step 2:** Run the listed tests → FAIL
- [ ] **Step 3:** Implement; follow `packages/tui/AGENTS.md` "Adding a column" and the look & feel rules (no new hues: `⇄`/`?` use the column's `sub` role).
- [ ] **Step 4:** `bun test packages/tui packages/cli && bun run typecheck` → PASS
- [ ] **Step 5:** Commit `feat(tui): host column, locality key and remote chips`

---

### Task 14: `inspect` and `hub status` show sync state

**Files:**
- Modify: `packages/cli/src/inspect.ts`, `packages/cli/src/hub-cmd.ts`
- Test: `packages/cli/tests/hub-cmd.test.ts`, `packages/cli/tests/inspect.test.ts` (create if absent)

**Interfaces:**
- Consumes: `GET /hosts`.
- `inspect` on a remote row adds `"host": <HostRow>` to its JSON.
- `hub status` (hub running) prints one line per host: `remote <remote>  <host>  ok|stale|removed  last sync <relTime>  agmux <ver>  cursor <n>[  rejected <n>][  error: <last_error>]`. When `replication > REPLICATION_VERSION`, it appends `note: <host> runs a newer replication format (<n>); update agmux`.

- [ ] **Step 1: Write failing tests** for both outputs (fake `fetchImpl`), including the newer-replication note and a removed host.
- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun test packages/cli` → PASS
- [ ] **Step 5:** Commit `feat(cli): sync state in inspect and hub status`

---

### Task 15: Docs, version, CI

**Files:**
- Create: `packages/hub/AGENTS.md`, `packages/store/AGENTS.md`
- Modify: `packages/tui/AGENTS.md` (host column, locality), `packages/cli/AGENTS.md` if present (else a section in the new hub doc covering `agmux events`), `README.md` (`[[remote]]`, `--remote/--local/--host`, `[ls]/[dash] locality`, `host` column, `AGMUX_HOST`), `CHANGELOG.md`, `packages/protocol/src/version.ts`, `.github/workflows/ci.yml`, `docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md` (status line: Phase 1 implemented; record Decisions 1–10 where they refine the spec)

- [ ] **Step 1:** Write `packages/hub/AGENTS.md`: the replication mechanism, end to end (wire format, cursor, `db_id`, follower lifetime/stdin rule, backoff and watchdog, ledger events, loop prevention, the transport/discovery seams for SSH later). Write `packages/store/AGENTS.md`: `events.source`, `hosts`, the read-time masking of remote rows, and why.
- [ ] **Step 2:** CI: after `bun test`, add `bun install --os='*' --cpu='*'` and `bun build --compile --target=bun-linux-x64 packages/cli/bin/agmux.ts --outfile /tmp/agmux-linux-x64` (and the same for `packages/hub/bin/agmux-hub.ts`), so the Linux binary the sandboxes need keeps building.
- [ ] **Step 3:** Bump the version, add the CHANGELOG entry.
- [ ] **Step 4:** `bun run typecheck && bun test` → PASS
- [ ] **Step 5:** Commit `docs(remote): phase 1 mechanisms, README and changelog`

---

## Not in this plan

- **homelab** (separate plan, other repo): `openshell/bin/stage-agmux`; the git-ignored `openshell/images/workbench/agmux/`; Dockerfile `COPY` for `${TARGETARCH}`; the Ansible `agmux/VERSION` assert + image prune (keep one prior); `sag-sandbox-create` `--label agmux=1 --env AGMUX_HOST=<gw>/<name>` + `agmux adapter install --kind claude`; the image `/etc/tmux.conf` (Phase 2).
- **Folding `agmux-hub` into `agmux hub serve`** (spec §4.9, "if cheap"): halves the image layer, but changes how the hub is spawned (`hub-spawn.ts`, `AGMUX_HUB_BIN`). Worth its own small plan once Phase 1 runs in a real sandbox.
- **Phase 2** (attach, N1/N2, reap) and **Phase 3** (control, final sync on sandbox finish).
