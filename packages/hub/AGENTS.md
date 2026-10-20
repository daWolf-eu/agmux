# AGENTS.md — `@agmux/hub`

The hub is the per-host query daemon (`src/server.ts`) and, on a machine with `[[remote]]` config, the **replication puller** (`src/sync/`). Remote sandbox sessions: each sandbox runs its own hub; the Mac pulls their event logs and ingests them as `source = <host>` rows. Design: `docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md` (see its "Phase 1 implementation notes").

## Replication wire format

`agmux events --follow --after <cursor> --consumer <id> --max-duration 3600` run in the sandbox (via the transport) prints NDJSON, one object per line (`ReplicationHeader` / `ReplicationRecord` in `@agmux/protocol/src/host.ts`, parsed by `parseStreamLine` in `sync/ingest.ts`):

- **header**, first line: `{replication, agmux, db_id, host}`. `replication` = `REPLICATION_VERSION` (1). A higher value is accepted (`checkHeader` → `newer`; `hub status` prints an "update agmux" note).
- **record**: `{id, ev}`. `id` = the sandbox `events.id` rowid; `ev` = the full `EventEnvelope`. Only `source IS NULL` rows are exported (`Store.listExportable`), `dedup_key` included in `ev` but dropped on ingest.
- **keepalive**: `{keepalive: <iso>}` after 15 s without a write (`KEEPALIVE_MS`, `cli/src/events-cmd.ts`). The sandbox polls its hub (`GET /events?after_id&limit`) every 500 ms.
- Anything else is an `invalid` line: counted in `rejected`, never fatal.
- **Line cap:** `splitLines` (`sync/follower.ts`) scans each byte once and holds at most `MAX_LINE_BYTES` (1 MiB) of a line; a longer one is dropped up to its `\n` and becomes `invalid line: too long` (the `LINE_TOO_LONG` sentinel). The source side caps too: `POST /ingest` bodies over `INGEST_MAX_BODY_BYTES` (1 MiB, `Bun.serve` `maxRequestBodySize`) get 413.

Hub side: `GET /events?after_id=<n>&limit=<n>` → `{records, last_id}` (default page `EXPORT_DEFAULT_LIMIT` 500, clamped to `EXPORT_MAX_LIMIT` 5000; `agmux events --limit` rejects > 5000 because a clamped full page would look short). `GET /health` carries `db_id`; `GET /hosts` = `{hosts, remotes}`: the `hosts` projection plus the sync loop's in-memory `RemoteSyncState[]` (`createServer({remotes})`; additive, `[]` without a sync loop).

## Cursor and `db_id`

The cursor is the sandbox's `events.id` rowid (monotonic per db). The Mac keeps it in `hosts.cursor` (via `host.synced`) and passes it as `--after`. `db_id` = random UUID minted once per store in `_meta`. If the header `db_id` differs from the stored one and the cursor is > 0 (sandbox recreated under the same name), the follower sets cursor 0, adopts the new `db_id`, and respawns immediately (`reset` outcome). The cursor never moves backwards within a connection. Re-pulled events are harmless: `appendReplicated` is idempotent on `event_id`. Every record is ingested with the header's `db_id` (`ingestReplicated(store, rec, host, sourceDb)` → `events.source_db`); the old incarnation's sessions then derive `lost` / `host-reset` once the next `host.synced` carries the new `db_id` (see `packages/store/AGENTS.md`).

## Follower lifetime (`sync/follower.ts`)

One `agmux events --follow` child per sandbox, through `Transport.argv(target, cmd, {tty: false})`.

- **stdin rule:** the child's stdin is **closed** (`spawnProcess`: `stdin: "ignore"`). `openshell exec --no-tty` may start the remote command only once the local stdin reaches EOF (observed on 0.0.116; closed stdin works whether or not a version does this); a held-open pipe means nothing ever runs (smoke test, spec §10 R19). The spike's "an open stdin ties the remote command to the local process" is moot.
- **Bounded remote side:** closed stdin orphans the remote `agmux events` when the local process dies. Two bounds, nothing else: the consumer lock (below; every reconnect SIGTERMs the previous one) and `--max-duration FOLLOW_MAX_DURATION_S` (3600 s), after which the remote command exits `EXIT_ROTATE` (75, EX_TEMPFAIL; `@agmux/protocol`) at its next loop boundary (after the current page). openshell propagates plain exit codes, so 75 reaches the follower.
- **Version skew:** sandboxes must run an agmux that knows `--max-duration` (same build as the Mac); an older one exits 2 (`unknown argument`) before the header and the node never syncs.
- **Rotation:** only a child that exits `EXIT_ROTATE` **after a valid header** is a planned rotation: respawn at once with `--after <cursor>`, no backoff, no failure recorded (`lastError`, `failingSinceMs`, the backoff count untouched). Status goes `connected: false` → `true` across it; the ledger writes no `host.sync_failed` because `failingSinceMs` stays null. Every other exit is a failure with backoff, including exit 0 (what a SIGTERMed `agmux events` returns, e.g. replaced via the consumer lock): two followers sharing a consumer id back off instead of replacing each other in a loop. 75 before a header is a failure too.
- **Watchdog:** no line (keepalives count) for `IDLE_TIMEOUT_MS` (60 s) → attempt fails. Aborting never waits for stdout EOF (`abortableReader`): a wedged child or a grandchild holding the pipe must not block the next attempt.
- **Kill:** `terminate` = SIGTERM, wait `KILL_GRACE_MS` (5 s), SIGKILL. `stop()` cancels all pending sleeps, aborts the read, then awaits the loop.
- **Backoff:** failure n waits `min(interval * 2^(n-1), MAX_BACKOFF_MS = 300 s)`; reset by the next header. Every reconnect catches up from the cursor, so there is no separate poll mode. A permanent failure (header host mismatch) waits the 300 s cap.
- **Single stream per consumer:** `--consumer` = `resolveHost()` with `[^A-Za-z0-9._-]` -> `_`, max 64 chars (`bin/agmux-hub.ts`). A new `agmux events --consumer X` SIGTERMs the previous one via `<state>/follow/X.pid`, so a reconnect never leaves two streams. Only if that pid is alive **and** an `agmux events` process (`isEventsProcess`: an `events` argument in `/proc/<pid>/cmdline` on Linux, `ps -o command=` elsewhere; unreadable = stale): a pid reused by an unrelated process is never signalled, the file is just overwritten.
- `onChange` throwing is logged, never a stream failure; a record that makes ingest throw is a rejected record. `ready()` (optional) gates ingest after each header (see the host ledger).

## Host ledger (`sync/sync-loop.ts`)

Per `[[remote]]`: every `interval` s, `Discovery.list()` → one follower per discovered node; the same tick runs `ledger()` for every node (also while `sandbox list` is in flight). The hub writes `host.*` events (`session_id = NO_SESSION_ID`, `host` = the node host, `dedup_key` null); the `hosts` projection (`store/src/hosts.ts`) is derived from them, so it survives `--rebuild-projections`.

- **`host.synced`:** on becoming ok (first header / recovery), and when the cursor moved, debounced to `CURSOR_FLUSH_MS` (10 s). Also flushed on the connected→failing transition and on stop/removal, **only** if the node was ok and connected (a failing host's stale overlay must not be cleared). Not flushed on a `db_id` reset.
- **ok only once written:** a node becomes ok only when its `host.synced` append succeeded. The follower asks `ready()` (= `ns.ok`) right after each accepted header; `false` fails the attempt (`host ledger write failed`, normal backoff) before any record is ingested, so remote rows never exist without their `hosts` row (they would read as local: unmasked pid/tmux).
- **`host.sync_failed`:** permanent error immediately; transient error once failing longer than `STALE_AFTER_INTERVALS` (3) x `interval`. Once per distinct error. `error` is `sanitizeRemoteText`ed.
- **`host.removed`:** the node is absent from `REMOVE_AFTER_MISSES` (2) consecutive *successful* listings (a failed listing counts as nothing; one empty listing must not flap sessions to lost). Stops the follower, then appends only if the row belongs to that remote and is not already removed. A node that reappears is restarted and the next `host.synced` clears `removed_ts` (rows of a previous incarnation stay `lost` via `host-reset`).
- `startSync` returns `SyncHandle {stop(), remotes()}`; `bin/agmux-hub.ts` bounds `stop` to 3 s and ignores a second signal (`shuttingDown`) so the lock is released exactly once. A broken `[[remote]]` config disables sync only, never the hub.
- **Visible state:** the hub runs with stdio ignored, so its log lines go nowhere. `remotes()` = per remote `{name, gateway, last_discovery_ts, last_discovery_error?, nodes}` (error `sanitizeRemoteText`ed, cleared by the next good listing); a config that failed to load is a single `{config_error}` entry. `agmux hub status` prints one `remote <name>  gateway <gw>  <n> sandbox(es)  last discovery <age>[  error: …]` line per remote before the host lines, `remote sync disabled: <error>` for a config error, and runs `loadRemotes` itself so a broken config shows while the hub is down (or as a `note:` when it broke after the hub started).

## Validation of replicated events (`sync/ingest.ts`)

Sandbox output is untrusted. `ingestReplicated(store, rec, expectedHost, sourceDb)` checks in this order; the first failure rejects the record (counted in `rejected`, `last_error = "record <id>: <reason>"`, cursor still advances):

1. `validateEnvelope`, then `session_id` must match `SESSION_ID_RE` (canonical UUID, not `NO_SESSION_ID`) and `event_id` `EVENT_ID_RE` (`[A-Za-z0-9-]{1,64}`) → `invalid envelope: …`. Ids reach shell/tmux command strings on the Mac (terminal-notifier `-execute`, status-line click ranges); the sinks additionally keep to `[0-9a-f-]` (`isShellSafeId` / `shellSafeIdChars`, `@agmux/protocol`).
2. kind starts with `host.` → `host event: … is hub-local`
3. `ev.host !== expectedHost` → `host mismatch: …`
4. `validateKnownPayload` → `invalid payload: …`
5. `store.sessionHost(session_id)` is another host → `foreign session: …`
6. `appendReplicated` throws (UNIQUE on native identity, deep nesting) → `append failed: …`

Reject-reason prefixes (stable, tests pin them): `invalid envelope`, `host event`, `host mismatch`, `invalid payload`, `foreign session`, `append failed`. All reasons and all other sandbox text that reaches storage or a terminal (stderr tail, `agmux_version`) go through `sanitizeRemoteText(s, max = 300)` (`@agmux/protocol`: control chars incl. C1 → space, collapse, cap). Sanitize at the writer **and** at the sink (`hub status`). `inspect` is not a sanitizing sink: it prints the verbatim JSON, safe through JSON escaping (`JSON.stringify` escapes C0; `terminalJson` in `cli/src/inspect.ts` adds `\u` escapes for DEL and C1). Session text in events (name, title, repo, branch, cwd, tool detail) is stored verbatim and goes through `stripControls` (`@agmux/protocol`: C0/DEL/C1 → space, no cap) at every display sink: `COLUMNS[*].text` (dash table, status line name), `formatTable` (`ls`, `watch`), status-line `fieldValue`, dash `detailFields` and `yankFields`, `explain`. A header whose `host` differs fails the whole stream (permanent) with the fix in the message: create the sandbox with `--env AGMUX_HOST=<gateway>/<sandbox>`.

## Loop prevention

`events.source` is NULL for events ingested locally and `<host>` for replicated ones. `listExportable` filters `source IS NULL`, so a hub never re-exports what it pulled. Keep this rule when adding a second hop (cross-host comms would need its own export path, not a relaxed filter).

## `/ingest` and reserved kinds

`POST /ingest` rejects any `host.*` kind with 400 `reserved_kind`. Only the hub writes those, through `Store.append` in the sync loop; otherwise a local client could poison the `hosts` projection.

## Config (`sync/config.ts`)

`[[remote]]` in `~/.config/agmux/config.toml`, read once at hub start (`agmux hub restart` after editing); only the `remote` key is parsed (a broken `[profiles.*]` can't affect the hub). Unknown keys are errors; a TOML syntax error is reported as `<config path>: <error>`.

| key | default | notes |
|---|---|---|
| `name` | required | config/display key only; `[A-Za-z0-9._-]+`, unique |
| `transport` | `openshell` | only `openshell` for now |
| `gateway` | required | same charset; becomes the host prefix |
| `selector` | `agmux=1` | passed to `sandbox list --selector` |
| `interval` | `5` | seconds, >= `MIN_INTERVAL_S` (0.1); discovery period and backoff base |
| `openshell_bin` | `openshell` | |
| `agmux_bin` | `agmux` | path of the binary inside the sandbox |

Host naming is discovery's job: `<gateway>/<sandbox>` (not `name`). Sandbox names starting with `-` are skipped (would parse as a flag).

## Seams for an SSH transport

`sync/transport.ts` `Transport { spec(target): TransportSpec; argv(target, cmd, {tty}): string[] }` is the only place that knows how to run a command on a node; `sync/discovery.ts` `Discovery { list(): Promise<{target, host}[]> }` is the only place that knows how to find nodes. `startSync` takes `discoveryFor` / `transportFor` (default: openshell). An SSH transport = a new `transport` value in `config.ts` + a `Transport` (argv `ssh host -- cmd`; re-check how stdin affects its remote lifetime, see the stdin rule) + a static or config-driven `Discovery`. `TransportSpec.kind` in `@agmux/protocol/src/host.ts` and the `hosts.transport` JSON need the new kind. Follower, ingest and ledger do not change.

## Remote sessions in the CLI

- `agmux events` (`cli/src/events-cmd.ts`): the remote end of replication (above). `--after <n>` is required; `--follow`, `--consumer <id>`, `--limit <1..5000>` (default 500), `--max-duration <s>` (positive integer, `--follow` only). One-shot mode exits after the first page that is not full. Exits 0 on SIGTERM/SIGINT or when stdout closes (EPIPE); `EXIT_ROTATE` (75) once `--max-duration` has passed (checked at each loop boundary).
- Remote guard (`cli/src/remote-guard.ts`): `attach`, `resume` and `kill` on a `remote` row print `<verb>: <id> runs on <host>; remote <verb> is not supported yet` and exit 2. Without it `kill` would signal a local pid and attach/resume would touch local tmux or relaunch the agent on the Mac. The dash's `x` on a remote row shows the same message as a footer notice (no kill confirm); `Actions.kill` refuses remote rows as the second line.
- `agmux ls`: `--remote | --local` (exclusive), `--host <glob>` (SQLite GLOB on `sessions.host`), `[ls] locality`. `parse-ls.ts`.
- `agmux hub status` (`hub-cmd.ts`) prints one `remote …` line per host (state, `last sync <rel> ago`, agmux version, cursor, rejected, last error); `agmux inspect` adds the `host` row for remote sessions (a `/hosts` failure is ignored).

## Running the e2e

`bun test tests/e2e/remote-sync.test.ts` — no OpenShell needed. It starts real hubs in temp HOMEs (the Mac and sandboxes `box1`/`box2`); `tests/e2e/fake-openshell.sh` stands in for `openshell` with the two verbs the loop uses: `sandbox list` (prints `$FAKE_OS_DIR/list.json`) and `sandbox exec -n <name> --no-tty -- cmd…` (drains stdin to EOF first, like 0.0.116, so a follower holding stdin open hangs the e2e; then runs `cmd` with `HOME=$FAKE_OS_DIR/<name>`, `AGMUX_HOST=<gw>/<name>`; names listed in `$FAKE_OS_DIR/nohost` get no `AGMUX_HOST` to simulate an old sandbox). Point `openshell_bin` at the script. Unit tests for the follower inject `deps` (`spawn`, `nowMs`, `sleep`); the sync loop injects `discoveryFor`, `transportFor`, `follower`, `nowMs`, `newId`.
