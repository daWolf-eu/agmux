# AGENTS.md — `@agmux/hub`

The hub is the per-host query daemon (`src/server.ts`) and, on a machine with `[[remote]]` config, the **replication puller** (`src/sync/`). Remote sandbox sessions: each sandbox runs its own hub; the Mac pulls their event logs and ingests them as `source = <host>` rows. Design: `docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md` (see its "Phase 1 implementation notes").

## Replication wire format

`agmux events --follow --after <cursor> --consumer <id>` run in the sandbox (via the transport) prints NDJSON, one object per line (`ReplicationHeader` / `ReplicationRecord` in `@agmux/protocol/src/host.ts`, parsed by `parseStreamLine` in `sync/ingest.ts`):

- **header**, first line: `{replication, agmux, db_id, host}`. `replication` = `REPLICATION_VERSION` (1). A higher value is accepted (`checkHeader` → `newer`; `hub status` prints an "update agmux" note).
- **record**: `{id, ev}`. `id` = the sandbox `events.id` rowid; `ev` = the full `EventEnvelope`. Only `source IS NULL` rows are exported (`Store.listExportable`), `dedup_key` included in `ev` but dropped on ingest.
- **keepalive**: `{keepalive: <iso>}` after 15 s without a write (`KEEPALIVE_MS`, `cli/src/events-cmd.ts`). The sandbox polls its hub (`GET /events?after_id&limit`) every 500 ms.
- Anything else is an `invalid` line: counted in `rejected`, never fatal.
- **Line cap:** `splitLines` (`sync/follower.ts`) scans each byte once and holds at most `MAX_LINE_BYTES` (1 MiB) of a line; a longer one is dropped up to its `\n` and becomes `invalid line: too long` (the `LINE_TOO_LONG` sentinel). The source side caps too: `POST /ingest` bodies over `INGEST_MAX_BODY_BYTES` (1 MiB, `Bun.serve` `maxRequestBodySize`) get 413.

Hub side: `GET /events?after_id=<n>&limit=<n>` → `{records, last_id}` (default page `EXPORT_DEFAULT_LIMIT` 500, clamped to `EXPORT_MAX_LIMIT` 5000; `agmux events --limit` rejects > 5000 because a clamped full page would look short). `GET /health` carries `db_id`; `GET /hosts` = the `hosts` projection.

## Cursor and `db_id`

The cursor is the sandbox's `events.id` rowid (monotonic per db). The Mac keeps it in `hosts.cursor` (via `host.synced`) and passes it as `--after`. `db_id` = random UUID minted once per store in `_meta`. If the header `db_id` differs from the stored one and the cursor is > 0 (sandbox recreated under the same name), the follower sets cursor 0, adopts the new `db_id`, and respawns immediately (`reset` outcome). The cursor never moves backwards within a connection. Re-pulled events are harmless: `appendReplicated` is idempotent on `event_id`. Every record is ingested with the header's `db_id` (`ingestReplicated(store, rec, host, sourceDb)` → `events.source_db`); the old incarnation's sessions then derive `lost` / `host-reset` once the next `host.synced` carries the new `db_id` (see `packages/store/AGENTS.md`).

## Follower lifetime (`sync/follower.ts`)

One `agmux events --follow` child per sandbox, through `Transport.argv(target, cmd, {tty: false})`.

- **stdin rule:** the child's stdin is a pipe that is **never written and never closed**. With `openshell sandbox exec --no-tty` that is what ties the remote command's life to the local process; a closed stdin orphans it. `spawnProcess` must keep `stdin: "pipe"`.
- **Watchdog:** no line (keepalives count) for `IDLE_TIMEOUT_MS` (60 s) → attempt fails. Aborting never waits for stdout EOF (`abortableReader`): a wedged child or a grandchild holding the pipe must not block the next attempt.
- **Kill:** `terminate` = SIGTERM, wait `KILL_GRACE_MS` (5 s), SIGKILL. `stop()` cancels all pending sleeps, aborts the read, then awaits the loop.
- **Backoff:** failure n waits `min(interval * 2^(n-1), MAX_BACKOFF_MS = 300 s)`; reset by the next header. Every reconnect catches up from the cursor, so there is no separate poll mode. A permanent failure (header host mismatch) waits the 300 s cap.
- **Single stream per consumer:** `--consumer` = `resolveHost()` with `[^A-Za-z0-9._-]` -> `_`, max 64 chars (`bin/agmux-hub.ts`). A new `agmux events --consumer X` SIGTERMs the previous one via `<state>/follow/X.pid`, so a reconnect never leaves two streams.
- `onChange` throwing is logged, never a stream failure; a record that makes ingest throw is a rejected record.

## Host ledger (`sync/sync-loop.ts`)

Per `[[remote]]`: every `interval` s, `Discovery.list()` → one follower per discovered node; the same tick runs `ledger()` for every node (also while `sandbox list` is in flight). The hub writes `host.*` events (`session_id = NO_SESSION_ID`, `host` = the node host, `dedup_key` null); the `hosts` projection (`store/src/hosts.ts`) is derived from them, so it survives `--rebuild-projections`.

- **`host.synced`:** on becoming ok (first header / recovery), and when the cursor moved, debounced to `CURSOR_FLUSH_MS` (10 s). Also flushed on the connected→failing transition and on stop/removal, **only** if the node was ok and connected (a failing host's stale overlay must not be cleared). Not flushed on a `db_id` reset.
- **`host.sync_failed`:** permanent error immediately; transient error once failing longer than `STALE_AFTER_INTERVALS` (3) x `interval`. Once per distinct error. `error` is `sanitizeRemoteText`ed.
- **`host.removed`:** the node is absent from `REMOVE_AFTER_MISSES` (2) consecutive *successful* listings (a failed listing counts as nothing; one empty listing must not flap sessions to lost). Stops the follower, then appends only if the row belongs to that remote and is not already removed. A node that reappears is restarted and the next `host.synced` clears `removed_ts` (rows of a previous incarnation stay `lost` via `host-reset`).
- `startSync` returns `stop()`; `bin/agmux-hub.ts` bounds it to 3 s and ignores a second signal (`shuttingDown`) so the lock is released exactly once. A broken `[[remote]]` config disables sync only (logged), never the hub.

## Validation of replicated events (`sync/ingest.ts`)

Sandbox output is untrusted. `ingestReplicated(store, rec, expectedHost, sourceDb)` checks in this order; the first failure rejects the record (counted in `rejected`, `last_error = "record <id>: <reason>"`, cursor still advances):

1. `validateEnvelope`, then `session_id` must match `SESSION_ID_RE` (canonical UUID, not `NO_SESSION_ID`) and `event_id` `EVENT_ID_RE` (`[A-Za-z0-9-]{1,64}`) → `invalid envelope: …`. Ids reach shell/tmux command strings on the Mac (terminal-notifier `-execute`, status-line click ranges); the sinks additionally keep to `[0-9a-f-]` (`isShellSafeId` / `shellSafeIdChars`, `@agmux/protocol`).
2. kind starts with `host.` → `host event: … is hub-local`
3. `ev.host !== expectedHost` → `host mismatch: …`
4. `validateKnownPayload` → `invalid payload: …`
5. `store.sessionHost(session_id)` is another host → `foreign session: …`
6. `appendReplicated` throws (UNIQUE on native identity, deep nesting) → `append failed: …`

Reject-reason prefixes (stable, tests pin them): `invalid envelope`, `host event`, `host mismatch`, `invalid payload`, `foreign session`, `append failed`. All reasons and all other sandbox text that reaches storage or a terminal (stderr tail, `agmux_version`) go through `sanitizeRemoteText(s, max = 300)` (`@agmux/protocol`: control chars incl. C1 → space, collapse, cap). Sanitize at the writer **and** at the sink (`hub status`, `inspect`). A header whose `host` differs fails the whole stream (permanent) with the fix in the message: create the sandbox with `--env AGMUX_HOST=<gateway>/<sandbox>`.

## Loop prevention

`events.source` is NULL for events ingested locally and `<host>` for replicated ones. `listExportable` filters `source IS NULL`, so a hub never re-exports what it pulled. Keep this rule when adding a second hop (cross-host comms would need its own export path, not a relaxed filter).

## `/ingest` and reserved kinds

`POST /ingest` rejects any `host.*` kind with 400 `reserved_kind`. Only the hub writes those, through `Store.append` in the sync loop; otherwise a local client could poison the `hosts` projection.

## Config (`sync/config.ts`)

`[[remote]]` in `~/.config/agmux/config.toml`; only the `remote` key is parsed (a broken `[profiles.*]` can't affect the hub). Unknown keys are errors.

| key | default | notes |
|---|---|---|
| `name` | required | config/display key only; `[A-Za-z0-9._-]+`, unique |
| `transport` | `openshell` | only `openshell` for now |
| `gateway` | required | same charset; becomes the host prefix |
| `selector` | `agmux=1` | passed to `sandbox list --selector` |
| `interval` | `5` | seconds, > 0; discovery period and backoff base |
| `openshell_bin` | `openshell` | |
| `agmux_bin` | `agmux` | path of the binary inside the sandbox |

Host naming is discovery's job: `<gateway>/<sandbox>` (not `name`). Sandbox names starting with `-` are skipped (would parse as a flag).

## Seams for an SSH transport

`sync/transport.ts` `Transport { spec(target): TransportSpec; argv(target, cmd, {tty}): string[] }` is the only place that knows how to run a command on a node; `sync/discovery.ts` `Discovery { list(): Promise<{target, host}[]> }` is the only place that knows how to find nodes. `startSync` takes `discoveryFor` / `transportFor` (default: openshell). An SSH transport = a new `transport` value in `config.ts` + a `Transport` (argv `ssh host -- cmd`; keep the stdin-pipe rule in mind) + a static or config-driven `Discovery`. `TransportSpec.kind` in `@agmux/protocol/src/host.ts` and the `hosts.transport` JSON need the new kind. Follower, ingest and ledger do not change.

## Remote sessions in the CLI

- `agmux events` (`cli/src/events-cmd.ts`): the remote end of replication (above). `--after <n>` is required; `--follow`, `--consumer <id>`, `--limit <1..5000>` (default 500). One-shot mode exits after the first page that is not full. Exits 0 on SIGTERM/SIGINT or when stdout closes (EPIPE).
- Remote guard (`cli/src/remote-guard.ts`): `attach`, `resume` and `kill` on a `remote` row print `<verb>: <id> runs on <host>; remote <verb> is not supported yet` and exit 1. Without it `kill` would signal a local pid and attach/resume would touch local tmux or relaunch the agent on the Mac. The dash's `x` on a remote row is a silent no-op.
- `agmux ls`: `--remote | --local` (exclusive), `--host <glob>` (SQLite GLOB on `sessions.host`), `[ls] locality`. `parse-ls.ts`.
- `agmux hub status` (`hub-cmd.ts`) prints one `remote …` line per host (state, `last sync <rel> ago`, agmux version, cursor, rejected, last error); `agmux inspect` adds the `host` row for remote sessions (a `/hosts` failure is ignored).

## Running the e2e

`bun test tests/e2e/remote-sync.test.ts` — no OpenShell needed. It starts real hubs in temp HOMEs (the Mac and sandboxes `box1`/`box2`); `tests/e2e/fake-openshell.sh` stands in for `openshell` with the two verbs the loop uses: `sandbox list` (prints `$FAKE_OS_DIR/list.json`) and `sandbox exec -n <name> --no-tty -- cmd…` (runs `cmd` with `HOME=$FAKE_OS_DIR/<name>`, `AGMUX_HOST=<gw>/<name>`; names listed in `$FAKE_OS_DIR/nohost` get no `AGMUX_HOST` to simulate an old sandbox). Point `openshell_bin` at the script. Unit tests for the follower inject `deps` (`spawn`, `nowMs`, `sleep`); the sync loop injects `discoveryFor`, `transportFor`, `follower`, `nowMs`, `newId`.
