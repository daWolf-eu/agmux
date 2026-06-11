# `agmux watch`, `@agmux/tui` seed, and `ls` ACTIVITY column

**Date:** 2026-06-11
**Status:** approved

## Goal

Live monitoring of sessions. Three deliverables:

1. **`ACTIVITY` column in `agmux ls`** — what the agent is doing right now
   (current tool / awaited input kind), derived server-side from events.
2. **`@agmux/tui` package (seed)** — the designated home for interactive
   terminal UIs (foundation doc §packages), started now so nothing is built
   throwaway. First contents: a `SessionFeed` data layer and an Ink session
   table.
3. **`agmux watch`** — fullscreen live-refreshing view of the `ls` table.

Roadmap context (drives the architecture, not this MVP's scope): an
interactive popup/sidebar with per-session actions, then a full lazygit-style
session manager, then inter-agent comms requiring real event streaming. The
`SessionFeed` abstraction is the seam where polling will be swapped for
SSE/subscribe when comms forces streaming onto the hub; UI code never knows.

## 1. Activity projection (store)

The `working/waiting/idle` state machine **already exists** as the session
`status` column (`turn.started`→running, `input.required`→waiting,
`input.received`→running, `turn.ended`→idle). Activity therefore only captures
what is currently dropped:

- `input.required.kind` (`prompt` | `permission` | `confirm`) — today the kind
  is lost, only `status=waiting` survives.
- `tool.used` (`tool`, `detail`) — today log-only, no projection effect.

New projection table (mirrors the `session_usage` pattern):

```sql
CREATE TABLE IF NOT EXISTS session_activity (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(session_id),
  last_tool        TEXT,     -- tool.used payload.tool
  last_tool_detail TEXT,     -- tool.used payload.detail
  last_input_kind  TEXT,     -- input.required payload.kind
  activity_ts      TEXT      -- ts of the event that last touched this row
);
```

Projection rules (in `applyEventToProjection`; writes are skipped for ended
sessions, same guard family as `applyLiveStatus`/`isFrozen` — exact mechanism
chosen at plan time):

| Event | Effect |
|---|---|
| `tool.used` | upsert `last_tool`, `last_tool_detail`, `activity_ts` |
| `input.required` | upsert `last_input_kind`, `activity_ts` |
| `input.received` | clear `last_input_kind` |
| `turn.started` | clear `last_tool`, `last_tool_detail` (new turn — a stale tool from the previous turn must not show as current) |
| `turn.ended` | clear `last_tool`, `last_tool_detail`, `last_input_kind` |

`listSessions` / `getSession` LEFT JOIN the table; `SessionRow` gains optional
fields `last_tool`, `last_tool_detail`, `last_input_kind`, `activity_ts`
(nullable, like `turn_count`: null = adapter never observed activity).
Schema bump via the existing migration mechanism in `migrations.ts`.

## 2. `ls` ACTIVITY column (cli)

Rendered from `status` + activity fields; no new flags:

| Condition | Cell |
|---|---|
| `status=running` and `last_tool` set | `tool: <tool>[ <detail>]` |
| `status=running`, no tool yet | `working` |
| `status=waiting` | `input: <last_input_kind \| "input">` |
| anything else | `-` |

Cell capped at 40 chars, truncating `detail` first. Column appended after
`TURNS`.

## 3. `@agmux/tui` package (new)

Library package (no own binary; the `agmux` binary bundles it). Dependency
direction: **cli → tui**, never the reverse.

- **`SessionFeed`** — `subscribe(query: LsQueryOpts, onUpdate: (rows: SessionRow[]) => void, onError: (e) => void): () => void`.
  First implementation **`PollingSessionFeed`**: fetches
  `GET /sessions?<buildLsQuery(query)>` every `intervalMs` (default 1000),
  in-flight guard (skip tick while a fetch is pending), shallow diff so
  `onUpdate` only fires when rows actually changed. Errors → `onError`
  (feed keeps polling; reconnect is free).
- **`<SessionTable rows reverse>`** — Ink component rendering the identical
  columns as `ls`. The pure row-formatting logic (column extraction,
  `short()`, activity cell) moves from `cli/src/ls.ts` into `tui` (e.g.
  `tui/src/format.ts`) and cli imports it — single source of truth, direction
  respected.
- **`<WatchApp>`** — wires feed → table, alternate screen buffer, footer line
  (`<n> sessions · refreshed 12:00:01 · q to quit`, or `hub unreachable —
  reconnecting…` on feed error while keeping the last table), `q`/`Ctrl-C`
  exit.

Risk to validate early in the plan: Ink (+ react) must survive
`bun build --compile` into the existing cli binary. Spike this in the first
plan task; fallback is a non-Ink ANSI repaint of the same `format.ts` output
behind the same feed (UI swap only, no architecture change).

## 4. `agmux watch` (cli)

```
agmux watch [--status …] [--agent …] [--profile …] [--sort started|activity]
            [--asc] [-n/--limit] [-r/--reverse] [-i/--interval <seconds>]
```

- Reuses the `ls` flag parser/query builder. Built-in defaults differ from
  `ls`: `--status open`, `--sort started` (descending). Stable start-time
  ordering is deliberate — activity-sort would reorder rows mid-watch and
  break the "my most recent agent is row 1" mental model while sessions have
  no human-readable label yet.
- `[ls]` config defaults do **not** apply to watch (a `[watch]` section can
  come later); flags always win over built-ins.
- Requires a TTY; exits 2 with a clear error otherwise.
- Hub is ensured running like every other verb.

## 5. Testing

- **store:** projection unit tests per event sequence (tool/input set+clear
  across turn boundaries, frozen-session guard, join shape of `listSessions`).
- **cli:** activity-cell rendering table tests; watch flag parsing + defaults.
- **tui:** `PollingSessionFeed` headless with injected fetch + fake timers
  (tick skip while in-flight, diff suppression, error path); `<SessionTable>`
  via `ink-testing-library`.
- Existing e2e stays green; `usage()` + README updated.

## Out of scope

- Recap/summary of agent output (capture-side feature, own design later).
- SSE / hub push (comes with the comms milestone; `SessionFeed` is the seam).
- Watch interactivity beyond quit (sidebar milestone: selection, actions).
- Session labels/names (prerequisite for activity-sorted watch UX).
