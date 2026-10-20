# AGENTS.md — `@agmux/store`

SQLite event log + projections. Everything is derived from `events`; `rebuildProjections()` replays it. Remote-session additions (schema v9, v10) below.

## Schema v9 (`src/schema.ts`)

- `events.source TEXT`: NULL = ingested on this host; `<host>` = replicated in from that host. Gates export (`listExportable`) and is the loop-prevention rule.
- `hosts` table: projection of `host.*` events (`src/hosts.ts`), keyed by `host`: `remote, transport (JSON), last_sync_ts, last_sync_ok, last_error, cursor, db_id, agmux_version, replication, rejected, removed_ts`.
- `_meta('db_id')`: random UUID minted on first `Store.dbId()` (inside an immediate transaction), stable for the life of the file. The sync cursor is only meaningful against one `db_id`.
- v10: `events.source_db` / `sessions.source_db`: the source store's `db_id` (its incarnation) for replicated rows, NULL for local ones. `sessions.source_db` follows the latest replicated event applied to the session (`applySourceDb`; `rebuildProjections` replays it from `events.source_db`).

## `appendReplicated(ev, source, sourceDb)`

Ingest of an event pulled from another host (the caller, `hub/src/sync/ingest.ts`, validates first; see `packages/hub/AGENTS.md`).

- `INSERT … ON CONFLICT(event_id) DO NOTHING`; returns false on a duplicate and does **not** re-apply the projection (unlike `append`, which re-applies `session.registered`).
- `dedup_key` is stored NULL: it was applied on the source, and this host's dedup index is global (a source key could suppress an unrelated local event).
- Row + projection run in one transaction. A hostile payload can make the projection throw (native-identity UNIQUE, deep nesting): callers must treat a throw as a rejected record.
- No native-identity resolution (`resolveAndAppend`): the event is stored verbatim under its own `session_id`.

## `listExportable(afterId, limit)`

`events` with `id > afterId AND source IS NULL`, oldest first → `{records: [{id, ev}], last_id}` (`last_id = afterId` when empty). `id` is the rowid; `dedup_key` is included in `ev` if set. `host.*` events are exportable like any other local event (they are never read back by a follower: ingest rejects the kind).

## `hosts` projection

`applyHostEvent` handles `host.synced` (upsert, sets ok, clears `last_error` and `removed_ts`), `host.sync_failed` (ok=0, `last_error`), `host.removed` (`removed_ts`). The hub is the only writer (`/ingest` rejects `host.*`). `getHost` / `listHosts` return `HostRow`.

## Remote rows on the read side (`src/queries.ts`)

`ROW_SELECT` LEFT JOINs `hosts` on `s.host`; a session is **remote** iff its host has a `hosts` row (`remote`, `sync_stale`, `last_sync_ts` on `SessionRow`).

- **Masking (Decision 4):** `decodeRow` nulls `pid`, `tmux_session/window/pane/socket` for remote rows. Stored events stay verbatim. Reason: these values only mean something on the host that produced them; consumers (`kill`, `attach`, `resume`, the pid sweep, the dash preview) would act on a *local* pid or tmux pane. The CLI's remote guard is the second line of defence.
- **`sync_stale`** = remote and `hosts.last_sync_ok = 0`. Presentation only (`?` chip/host label); status is untouched.
- **host-removed rule:** `deriveStatus` (`src/lost.ts`) returns `lost` with rule `host-removed` for a non-terminal row whose host has `removed_ts` set. It comes before the heartbeat rule. A later `host.synced` clears `removed_ts` and the row reverts: intended only for a listing gap (same `db_id`).
- **host-reset rule:** next, a non-terminal row whose `source_db` is set and differs from its host's current `hosts.db_id` (`h.db_id AS host_db_id` in `ROW_SELECT`) is `lost` with rule `host-reset`, reason `host <h> was recreated (db <old8> → <new8>)`. A sandbox recreated under the same name thus never resurrects the previous incarnation's sessions, with or without a `host.removed` in between. Rows without `source_db` (local, or replicated before v10) are exempt.
- Native rows of remote hosts are never pid-swept (`listLiveNativeSessions` excludes hosts with a `hosts` row).

## Locality and host filters

`ListSessionsOpts.locality` (`"local" | "remote"`: `h.host IS NULL` / `IS NOT NULL`) and `host` (SQLite `GLOB` on `s.host`, e.g. `ai-sandbox/*`). Both are SQL `WHERE` parts; `status` is still filtered after derivation.
