# agmux dash — interactive TUI design

Date: 2026-06-15
Status: Approved design, pre-implementation
Branch: `feature/lazy-ag`

## 1. Summary

A new `agmux dash` verb: a lazygit-style, full-screen interactive TUI for viewing and
managing agent sessions. Grouped session table on the left, resizable preview pane on the
right, hjkl/vim navigation. The existing read-only `agmux watch` command stays as-is.

v1 scope is the **Sessions view only**. Usage/limits views and project-based grouping are
explicitly out of scope but designed-for via seams (see §10).

## 2. Goals / non-goals

**Goals**
- One screen to scan all sessions grouped by status (needs-input first), with live refresh.
- Preview the selected session three ways — live pane mirror, event-log tail, detail card —
  toggleable, with a configurable default.
- Jump to a session's tmux pane without losing the TUI (`switch-client`).
- Kill a live session and resume/relaunch a dead one, from the TUI.

**Non-goals (v1)**
- Usage/limits aggregation view.
- Project/agent grouping (no human-friendly project labels exist yet).
- Starting brand-new sessions (`agmux run`) from the TUI.
- A "grab the live pane" (join-pane) action — rejected as too fragile (see §9).

## 3. Relationship to `agmux watch`

`watch` remains the simple, read-only, live `ls` table. `dash` is the separate, richer,
interactive surface. They share the `@agmux/tui` package primitives (`SessionFeed`,
`PollingSessionFeed`, the `format.ts` patterns) but are distinct verbs and components.

## 4. Layout & interaction

Layout "B": grouped table + resizable preview split.

```
┌ Sessions (11) ─────────────────────────────────┐┌ 4f3a · claude · feature/lazy ─────────┐
│ ID    AGENT  PROFILE  ACTIVITY      TURNS  LAST ││ mirror  events  detail                │
│ ⚠ NEEDS INPUT ─────────────────────────────     ││────────────────────────────────────────│
│›4f3a  claude main     input:permission 12   3s  ││ > Edit packages/cli/src/attach.ts      │
│ 9c1e  codex  –        input:prompt      4   9s  ││   Allow this edit? (y/n)               │
│ ● WORKING ─────────────────────────────────     ││  ...                                   │
│ 2b8e  claude feat     tool:Edit        21   1s  ││                                        │
│ ○ IDLE ────────────────────────────────────     ││                                        │
│ f8a2  claude main     –                33   2m  ││                                        │
│ ✓ CLOSED ───────────────────────────────────    ││  ↻ live · capture-pane ~1s             │
└──────────────────────────────────────────────────┘└────────────────────────────────────────┘
 j/k row  { } group  < > resize  tab preview  ⏎ attach  x kill  r resume  / filter  ? help  q quit
```

- **Columns:** `ID · AGENT · PROFILE · ACTIVITY · TURNS · LAST` (last-seen). `STATUS` is the
  group header, so it is dropped as a column. `PID`, `TMUX`, full timestamps, and usage live
  in the *detail* preview.
- **Groups & order:** `NEEDS INPUT` (waiting) → `WORKING` (running) → `IDLE` (idle) →
  `CLOSED` (ended/lost). Maps directly onto the existing `SessionStatus` state machine.
- **Selection:** one row highlighted; the preview always reflects it.

### Keybindings

| Key | Action |
|-----|--------|
| `j` / `k` | move row down / up (skips group headers) |
| `{` / `}` | jump to previous / next group |
| `<` / `>` | shrink / grow the left/right split |
| `tab` | cycle preview mode (mirror → events → detail) |
| `⏎` | attach to selected session (see §6) |
| `x` | kill selected live session (confirm modal) |
| `r` | resume/relaunch selected closed/lost session |
| `/` | filter (incremental, by id/agent/profile/activity) |
| `?` | toggle help overlay |
| `q` | quit (restores screen) |

`h`/`l` are reserved/aliased for pane focus and split adjust so movement stays vim-like.

## 5. Preview modes

Three modes, cycled with `tab`. Default is read from config; ships defaulting to `events`
(works for every session, live or dead).

- **mirror** — periodically runs `tmux capture-pane -p -t <pane>` for the selected session
  and renders the captured text. Only polls while the mirror tab is active **and** the
  session is live with valid pane coords. Falls back to `events` for dead sessions or when
  `capture-pane` fails ("pane unavailable").
- **events** — tails the event log via `GET /events?session_id=<id>&limit=N`, newest at the
  bottom. Works for live and dead sessions. Polled on the refresh interval while active.
- **detail** — structured card derived from the in-memory `SessionRow` + usage fields
  (status, branch/project, command, pid, tmux coords, turns, tokens, cost, model,
  last activity). Pure render, no I/O.

Config (`[dash]` in `~/.config/agmux/config.toml`): `preview` (mirror|events|detail),
`split` (ratio), `interval` (seconds), default `status`/`sort` — same pattern as `[ls]`.

## 6. Actions

- **attach (`⏎`)** — if running inside tmux, `switch-client` to the agent's window (and
  `select-pane`); the TUI keeps running in its own window so the user can flip back. If
  **not** inside tmux, restore the alt-screen and hand off to a blocking `attach-session`
  (the TUI exits). Reuses `attach.ts` `buildAttachCommands`. Disabled with a note when the
  selected session is dead or has no tmux coords.
- **kill (`x`)** — confirm modal, then wraps `agmux kill` for the selected live session.
- **resume (`r`)** — enabled only on closed/lost rows; wraps the relaunch/native-resume path
  already in `attach.ts` (`buildRelaunchSpec`).

Actions are fire-and-forget; the session feed reflects the resulting state on its next poll.

## 7. Architecture

### Package boundaries
`@agmux/tui` stays pure (depends only on `@agmux/protocol`): it does **no** tmux, process,
or HTTP work itself. The CLI injects all side-effecting dependencies, mirroring how
`SessionFeed` is already injected into `runWatch`.

### New / changed files

**`packages/tui/src/`**
- `run-manage.tsx` — entry, parallel to `run-watch.tsx`: alt-screen enter/restore, raw
  stdin, `render(<ManageApp/>)`, returns exit code.
- `manage-app.tsx` — the shell. State: rows, selected id, focused pane, preview mode, split
  ratio, filter string, confirm-modal state, current view (enum, v1 = `sessions`). Owns the
  `useInput` keymap.
- `session-list.tsx` — renders the grouped table + selection highlight.
- `group-table.ts` — pure grouped-table formatter (group headers + columns), extending the
  existing `format.ts` patterns.
- `preview.tsx` — header tabs + body; switches the three modes.
- `keymap.ts` — binding table; drives footer + `?` help.
- Index exports: `runManage` and the injected-dependency interfaces.

**Injected interfaces (defined in `tui`, implemented in `cli`)**
- `SessionFeed` — reuse existing `PollingSessionFeed`.
- `PreviewSource` — `mirror(row): Promise<string>` (runs `capture-pane`),
  `events(row): Promise<EventRow[]>` (fetches `/events`). Detail needs no source.
- `Actions` — `attach(row)`, `kill(row)`, `resume(row)`.

**`packages/cli/`**
- `bin/agmux.ts` — add `case "dash":` next to `watch`.
- `src/dash.ts` — parallel to `watch.ts`: TTY guard (return `2`), build query from `ls`
  filters, construct concrete `PreviewSource` (tmux `capture-pane` runner + `/events` fetch)
  and `Actions` (reusing `attach.ts`/`kill.ts`), call `runManage(...)`.
- `src/parse-dash.ts` — arg parsing (reuse `ls` flags + `-i/--interval` + `--preview`).
- Refactor as needed: expose the attach/kill helpers from `attach.ts`/`kill.ts` as callable
  functions for the `Actions` adapter (extract from the command handlers if they aren't
  already reusable). Command-builder functions (`buildAttachCommands`, the `capture-pane`
  argv builder) stay pure for testing.

## 8. Data flow & refresh

1. `PollingSessionFeed` polls `/sessions` → `SessionRow[]` → grouped → rendered.
2. The active preview tab pulls only its own data, gated to avoid waste:
   - mirror: `capture-pane` ~1s, only when active + session live.
   - events: `/events` on the refresh interval while active.
   - detail: derived from the current row, no I/O.
3. Actions invoke injected `Actions`; the next feed poll reflects new status.

## 9. Edge cases & error handling

- Not a TTY → exit code `2` (matches `watch`).
- Not inside tmux → attach falls back to exit-then-`attach-session`; documented.
- Selected session has no pane / is dead → mirror falls back to events; attach disabled with
  a note; kill disabled; resume enabled (if closed/lost).
- `capture-pane` failure (pane gone mid-session) → "pane unavailable", fall back to events.
- Hub down / empty list → error line, same approach as `WatchApp`.
- Terminal too narrow → clamp the split to a minimum; below a threshold, render table-only
  and hide the preview.
- Kill always behind a confirm modal; resume only enabled for closed/lost rows.

## 10. Future seams (designed-for, not built)

- **Usage view:** `ManageApp` carries a `view` enum (v1 = `sessions`). A second `usage` view
  (aggregating `session_usage`: tokens/cost/model/rate-limit across sessions/providers) can
  be added as another view with a switch key. No v1 implementation.
- **Group-by strategy:** grouping is a pluggable function (status now). When project/agent
  labels exist, add a `g` group-by toggle (project, agent_kind).
- **Grab-live pane:** the rejected `join-pane` approach could return as an optional power
  action if the fragility is ever addressed.

## 11. Testing

- Pure formatters (`group-table`) and `detail` rendering → unit tests like `format.test.ts`.
- Command builders (`capture-pane` argv, attach argv) → pure-function tests (build, don't
  exec).
- `ManageApp` → `ink-testing-library` + fake `SessionFeed`/`PreviewSource`/`Actions`,
  asserting row nav, group jump, preview toggle, filter, and the confirm modal — same
  approach as `watch-app.test.tsx`.
