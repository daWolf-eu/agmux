# dash activity-group filter + resume-on-closed — design

**Date:** 2026-06-25
**Branch:** `feat/dash-activity-filter-options`
**Status:** approved

## Problem

`agmux dash` only ever shows **open** sessions (`idle`, `running`, `waiting`). The
status filter is fixed server-side at startup (`buildLsQuery` sets `status=open`),
so closed sessions (`ended`, `lost`) never reach the TUI and there is no way to
review them. Additionally, pressing Enter on a non-live session is a silent no-op
(`attach` returns `null` for any non-`LIVE_STATUSES` row).

We want:
1. A runtime filter to switch the visible set between activity groups **open**,
   **closed**, and **all**.
2. Pressing Enter on a **closed** session to gracefully **resume** it (relaunch the
   agent), opening it in a new window of the tmux session dash itself is running in
   (i.e. wherever the user called dash from). This matters because dash is often
   run as a tmux popup, and landing the resumed agent in the caller's session is
   the least surprising behavior.

## Background (current architecture)

- **Statuses** (`packages/protocol/src/session.ts`): `LIVE_STATUSES = [idle,
  running, waiting]`, `TERMINAL_STATUSES = [ended, lost]`. `STATUS_GROUPS` already
  defines `open` (= live), `closed` (= terminal), `active` (= running+waiting).
- **Hub** (`packages/hub/src/server.ts:44`): `GET /sessions` returns **all
  statuses when `status` is omitted**; an explicit `?status=` filters server-side.
- **Feed** (`packages/tui/src/feed.ts`): `PollingSessionFeed` polls a fixed URL
  built from `buildLsQuery`; it diffs by JSON and only notifies on change.
- **DashApp** (`packages/tui/src/opentui/DashApp.tsx`): subscribes to the feed,
  then filters/sorts **client-side**: `visible = sortRows(filterRows(rows, filter),
  sortKey)`. `s` cycles sort, `/` enters text-filter mode.
- **Attach** (`packages/cli/src/dash-actions.ts:83`): returns `null` unless the row
  is live with tmux coords; otherwise builds tmux attach/switch-client commands.
- **Resume** (`dash-actions.ts:97`): already implemented but **not bound to any
  key** in the opentui dash. Builds a relaunch spec; in popup mode places the agent
  in a new tmux window.
- **tmux placement** (`packages/cli/src/tmux-place.ts`): `hasSession`,
  `newWindow` (calls `ensureSession` first), `newSession` (throws if exists),
  `switchClient`.

## Terminology change

The free-text match (`/`) is currently called "filter". The new feature is also a
filter, so rename to disambiguate:

- **`/` → "search"** — the free-text match. Rename user-facing labels, the DashApp
  `filter`/`filtering` state to `search`/`searching`, and `packages/tui/src/shared/
  filter.ts` → `shared/search.ts` (`matchesFilter`/`filterRows` →
  `matchesSearch`/`searchRows`). Update imports and tests.
- **`f` → "filter"** — the new activity-group selector.

## Design

### 1. Activity-group filter (client-side)

- New type `ActivityGroup = "open" | "closed" | "all"` and a predicate
  `inGroup(row, group)`:
  - `open` → `LIVE_STATUSES.includes(status)`
  - `closed` → `TERMINAL_STATUSES.includes(status)`
  - `all` → always true

  Lives alongside sort/search in `packages/tui/src/shared/` (e.g. `group.ts`), with
  a `nextGroup(g)` cycler `open → closed → all → open`.

- **Fetch strategy: client-side filtering.** The dash fetches *all* statuses and
  filters in the TUI, reusing the existing client-side filter/sort pattern.
  - `dash.ts` / `buildLsQuery`: stop sending `status` to the hub for dash (omit it
    → hub returns all). The query still carries `agent`/`profile`/`sort`/`order`/
    `limit`.
  - The resolved `--status`/config value derives the **initial group** instead of
    a server filter. `initialGroup(status)`:
    - `undefined` / `open` / `active` → `open` (default — no regression)
    - `closed` → `closed`
    - raw/csv statuses: all ⊆ terminal → `closed`; all ⊆ live → `open`; mixed →
      `all`
  - Plumb `initialGroup` through `runManage` → `DashApp` as a prop.

- **DashApp** holds `group` state, key `f` calls `setGroup(nextGroup)`.
  `visible = sortRows(inGroupFilter(searchRows(rows, search), group), sortKey)`.

- **HeaderBar**: compute the count badges over **all fetched rows** (pass `rows`,
  not `visible`) so the `closed` count remains visible while viewing `open` — a
  hint that there is something to switch to. Add an active-group indicator near the
  title (e.g. `[open]`).

- **FooterBar hint + help panel**: `… s sort · f filter · / search …`.

- **Known bound:** `all`/`closed` views are capped by `--limit` (default 50, like
  `ls`); old closed sessions beyond the limit are not shown. Documented, not fixed.

### 2. Enter on a closed session → resume

- **Status-aware Enter** in `DashApp`: live status → `actions.attach` (unchanged);
  terminal status (`ended`/`lost`) → `actions.resume`. Both return `Handoff | null`
  and share the existing handoff handling.

- **`resume` placement** targets *the session dash is running in* (the caller's
  session): `target = currentPaneSession ?? row.tmux_session ?? "agmux"` — keeping
  the current code's existing preference (current pane first). In popup/inline-tmux
  the current session always exists, so this is normally a new window in the
  caller's session.
  - `await hasSession(target)`:
    - **exists** → `newWindow({ sessionName: target, windowName: 'agmux:<id8>',
      cmd: spec.wrapArgv, env: relaunchEnv(spec.env), detach: true })`
    - **missing** (only when dash runs outside tmux and no live session resolves)
      → `newSession({ sessionName: target, windowName: 'agmux:<id8>', cmd, env })`
      — creates the session with the agent as its first window (avoids the stray
      empty window the old `ensureSession`+`newWindow` path produced).
  - Then `switchClient('<coords.session>:<coords.window>')` so the user lands on
    the resumed agent's new window.

- **Return contexts** mirror `attach`:
  - **popup** (`popup=true`) → empty-argv `Handoff` (`{ argv: [] }`) so the popup
    closes onto the freshly switched-to agent.
  - **inline tmux** (`process.env.TMUX`, not popup) → `null` (the client was
    already switched; dash stays alive in its pane, as inline attach does).
  - **outside tmux** → `{ argv: spec.wrapArgv, env: spec.env }` (the agent takes
    over the terminal after dash exits — existing behavior).

- `resume`'s spec-building (`buildRelaunchSpec`, native-resume vs profile reload)
  is unchanged; only placement + return shaping change.

### 3. Graceful failure

- Wrap the attach/resume dispatch in the Enter handler with try/catch. On failure,
  set a transient `notice` string shown in the FooterBar (e.g.
  `resume failed: <msg>`) rather than a silent no-op or crash.
- `x`/kill stays gated to live statuses (closed rows: no-op, as today).

## Components touched

| File | Change |
|------|--------|
| `packages/tui/src/shared/filter.ts` → `search.ts` | rename module + exports (`matchesSearch`/`searchRows`) |
| `packages/tui/src/shared/group.ts` (new) | `ActivityGroup`, `inGroup`, `nextGroup`, `GROUPS` |
| `packages/tui/src/opentui/DashApp.tsx` | `group` state + `f` key; rename `filter`→`search`; status-aware Enter; `notice` state; pass full `rows` to HeaderBar |
| `packages/tui/src/opentui/HeaderBar.tsx` | counts over all rows + active-group indicator |
| `packages/tui/src/opentui/FooterBar.tsx` | hint wording + `notice` line |
| `packages/tui/src/opentui/run-manage.tsx` + `types.ts` | thread `initialGroup` prop |
| `packages/cli/src/dash.ts` / `parse-dash.ts` / `ls.ts` | derive `initialGroup`; omit `status` from the dash hub query |
| `packages/cli/src/dash-actions.ts` | resume placement (target = caller's session; exists→newWindow / missing→newSession; switchClient; context-aware return) |

## Testing

- **Unit**
  - `inGroup`/`nextGroup` predicate + cycler.
  - `initialGroup(status)` derivation across `open`/`active`/`closed`/csv/mixed/
    undefined.
  - `resume` placement with injected tmux deps: target prefers caller's (current
    pane) session; exists → `newWindow`; missing → `newSession`; `switchClient`
    target correct; return shape per context (popup / inline / outside-tmux).
  - Status-aware Enter dispatch (live → attach, terminal → resume).
- **Keep & update**: existing search (renamed) and sort tests.
- **Manual**: popup resume of a closed session → agent opens in a new window of
  the caller's session and the client lands on it. Outside tmux → caller session
  missing path recreates a session and lands on the agent.

## Out of scope

- Raising/changing the fetch limit or paginating closed history.
- A standalone `r` resume key for live sessions (resume is reachable only via Enter
  on a closed row; resuming a live session is meaningless).
- Server-side streaming changes to the feed.
