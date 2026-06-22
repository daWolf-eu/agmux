# OpenTUI `dash` Spike — Design

**Date:** 2026-06-20
**Status:** Approved (design); pending implementation plan
**Scope:** `agmux dash` only. Other CLI commands (`ls`, `run`, etc.) are out of scope.

## Decision

Migrate the `agmux dash` TUI from **Ink** to **OpenTUI (React binding)**, staying entirely in the
TypeScript/Bun ecosystem. Bubbletea (Go) was evaluated and rejected: it would fragment the stack into a
second language for a single command, contradicting the all-TS goal.

OpenTUI's usual blocker — native FFI requiring Bun or Node 26.3.0 `--experimental-ffi` — does not apply:
agmux already runs and ships on Bun (`bun test`, `bun build --compile`).

### Chosen approach: promotable vertical slice (behind a flag)

A real OpenTUI dash built **alongside** the Ink one in `@agmux/tui`, selected at runtime via
`AGMUX_TUI` env (`ink` default | `opentui`). It reuses the existing framework-agnostic data layer
(`PollingSessionFeed`, `@agmux/protocol`, `dash-preview`, `dash-actions`). If it proves out, it becomes the
migration foundation; if not, delete the flag branch and the `opentui/` directory. Ink stays default and
untouched during the spike.

Rejected alternatives: throwaway feel-test (proves nothing about integration/real-mirror perf); full
parallel rewrite (premature before validating the engine feels right).

## Motivation / target UX

Current Ink dash is well-engineered but hits an engine ceiling: navigation still feels sluggish and the
UX is not what we want. Target UX (confirmed):

- Visually distinct **bordered panels**, **color-coded status**, clear **visual hierarchy**.
- **Mouse support** (click-to-select, wheel scroll).
- **Full keyboard discoverability** with **vim bindings** where possible.
- **Smooth navigation** above all — the preview may render asynchronously and lag a frame or two behind
  selection if that keeps navigation instant.

## Layout — table is the hero, preview is an aside

Flat, sortable, filterable session table (no group sections; status is conveyed by the activity glyph).
Table takes the available width and scales with the viewport split; preview defaults to ~45%.

```
 agmux dash   ● hub connected      7 sessions · 1 needs input · 3 running · 2 idle · 1 closed
┌─ Sessions (sort: status ▾  filter: —) ──────────────────────────────┐┌─ Mirror  Events Detail ─────┐
│   ◍  ID            TMUX                    AGENT    PROFILE  TURNS  LAST │ agx-7f3a2b9c1 · claude · review │
│ ▶ ⚠  agx-9d2c1a0f4  %3 main:agmux.1         claude   review    14    3s  │ ─────────────────────────────  │
│ ◆ ●  agx-7f3a2b9c1  %5 work:build.0…        claude   default   23    12s │ $ npm test                     │
│   ●  agx-1b8e6633a  %7 work:codex.2         codex    default    8    44s │ ● running 14 tests…            │
│   ○  agx-3c5d7e911  %2 main:notes.1         claude   default   31    6m  │ ✓ feed.test.ts                 │
│   ·  agx-0f1b2c3d4  —                       claude   default   17    yest.│ …                              │
└─────────────────────────────────────────────────────────────────────┘└─────────────────────────────┘
 j/k move · g/G top/bottom · s sort · / filter · ⏎ attach · x kill · tab preview · : cmd · ? help
```

### Columns (order: glyph first)

| Col | Source (`SessionRow`) | Rendering |
| --- | --- | --- |
| ◍ activity | derived from `status` (+ `last_input_kind`, `signal`/`exit_code`) | glyph only, colored |
| ID | `session_id` | truncate first 13 chars, **no ellipsis**, muted color |
| TMUX | `tmux_session:tmux_window` | truncate first 32, **with ellipsis**, highlighted |
| AGENT | `agent_kind` | normal |
| PROFILE | `profile` | normal |
| TURNS | `turn_count` | right-aligned numeric |
| LAST | `last_heartbeat_ts ?? start_ts` | relative time, right-aligned |

### Activity glyphs / colors

| State | Glyph | Color |
| --- | --- | --- |
| needs input (`waiting`) | `⚠` | amber `#f9e2af` |
| running | `●` | green `#a6e3a1` |
| idle | `○` | grey `#6c7086` |
| error (`ended` with non-zero `exit_code` or a `signal`) | `✖` | red `#f38ba8` |
| closed (`ended` clean exit, or `lost`) | `·` | muted `#585b70` |

`lost` is treated as **closed** (muted), not error. Only an `ended` session that exited non-zero / on a
signal gets the red error glyph.

### Markers (gutter, before glyph)

- **Selection cursor** `▶` + row background highlight.
- **Attached** `◆` (teal) — the session open in the parent tmux where dash was launched.

### Confirmed behaviors

- **Default sort:** status priority (needs-input → running → idle → closed), then most-recent activity.
  Toggleable via `s`.
- **Relative LAST:** recomputed each poll tick (1s) so "3s → 4s" updates live; falls back to
  `YYYY-MM-DD` beyond ~1 day. No extra timer — the feed already re-renders.
- **Attached marker:** best-effort. No detection exists in the codebase today; implement by matching a
  session's `tmux_pane` against the parent tmux context (`$TMUX` / tmux client query). If unresolved, the
  gutter is blank — purely additive, never blocks.

## Architecture & file layout

```
packages/tui/src/
  run-manage.tsx          (existing Ink entry — untouched, stays default)
  feed.ts                 (REUSED as-is — framework-agnostic polling store)
  shared/                 (NEW: pure logic, no framework imports — shared + unit-testable)
    columns.ts            cells, truncation (ID 13 / TMUX 32+…), widths, alignment
    sort.ts               default status-priority sort + toggle
    filter.ts             fuzzy match (lifted from group-table matchesFilter)
    glyph.ts              status → { glyph, color }
    reltime.ts            timestamp → "3s" / "10m" / "yesterday" / "2026-06-02"
  opentui/                (NEW: OpenTUI React binding)
    run-manage-otui.tsx   renderer lifecycle + createRoot
    DashApp.tsx           root: feed subscription + UI state
    HeaderBar.tsx
    SessionTable.tsx
    PreviewPane.tsx
    FooterBar.tsx
```

The `shared/` extraction is the key structural move: framework-agnostic, testable without a renderer,
shared by both bindings, and it de-risks the eventual full cutover.

**Dependencies:** add `@opentui/core`, `@opentui/react` (keep `ink` for now).
**JSX config:** Ink uses `react` JSX; OpenTUI needs `jsxImportSource: "@opentui/react"`. Since both live in
one package, use a per-file pragma `/** @jsxImportSource @opentui/react */` in `opentui/*.tsx` to avoid
splitting tsconfig. (Confirm during implementation.)

**CLI wiring** (`packages/cli/src/dash.ts`): branch on `AGMUX_TUI` env (`ink` default | `opentui`).
Existing TTY validation stays. `@agmux/tui` exports both `runManage` (Ink) and `runManageOtui` (OpenTUI).

## Data flow

- **Feed → sessions:** reuse `PollingSessionFeed` via `useSyncExternalStore` (as Ink does today).
- **Derived rows:** `useMemo(() => filter(sort(sessions), …))`; relative time recomputes each render.
- **`<DashApp>` state:** `selectedId`, `sortKey`, `filter`, `previewMode`, `splitPct`.
- **Layout:** flexbox `<box>` — table `flexGrow`, preview fixed ~45%.
- **`<SessionTable>`:** `<scrollbox>` of rows; row = gutter + glyph + per-cell colored columns; header row
  with sort indicator.
- **`<PreviewPane>`:** tab strip + a **mode-keyed body child** so a future `detail-card + last-agent-message`
  view drops in behind the same interface (`mirror | events | detail | <future>`).

## Async-preview decoupling (core perf mechanism)

- **Navigation is synchronous:** `j/k` mutates `selectedId` → table repaints immediately, never blocked by
  preview work.
- **Preview is async + debounced:** `useEffect([selectedId])` waits ~80ms, then fires the tmux
  `capture-pane` fetch (reusing `dash-preview`). Result stored in a buffer **tagged by `session_id` + a
  request token**; stale responses are dropped (reuse the existing tagged-buffer pattern). The preview may
  render a frame or two behind selection — by design.

## Input model

- **Keyboard** (`useKeyboard`): `j/k` move, `g/G` top/bottom, `{ }` / PgUp-PgDn page, `< >` resize,
  `tab` preview-mode, `s` sort, `/` filter, `:` command (stub for spike), `?` help, `⏎` attach,
  `x` kill (confirm), `q` quit.
- **Mouse** (OpenTUI native): click row → select; wheel → scroll table/preview.
- **Discoverability:** always-visible footer hints + `?` help overlay.

## Error handling & lifecycle

- OpenTUI does **not** auto-clean on exit: call `renderer.destroy()` on quit, register `exitSignals`
  (SIGINT/SIGTERM), restore terminal. Alt-screen via `screenMode: "alternate-screen"`.
- **Hub disconnect:** feed already reconnects; header shows `● connected / ◌ reconnecting`.
- **Preview fetch failure** (pane gone): muted "no mirror output"; never crash.
- **Renderer init failure:** catch, restore terminal, print error (Bun has FFI; safety net only).
- **Non-TTY:** already guarded in `dash.ts` before launch.

## Testing

- **Pure-fn tests (bulk, no renderer):** `shared/` modules — columns/truncation, sort, filter, glyph
  mapping, relative-time.
- **Smoke test (OpenTUI test renderer):** app mounts; `j/k` moves selection; `tab` cycles preview mode.
  Confirm exact test-renderer API against the OpenTUI testing doc during implementation.
- Existing Ink tests stay green (Ink remains default).

## Scope

**In:** flagged OpenTUI dash · header · hero table (all columns/glyphs/colors/markers) · vim nav + mouse ·
sort + filter · async-decoupled preview (existing mirror/events/detail) · **attach wired** ·
**kill + confirm wired** (validates the modal pattern; cheap via `dash-actions`) · relative time ·
best-effort attached marker · lifecycle/cleanup · pure-fn + smoke tests.

**Deferred / stubbed:** `resume` action · full `:` command palette · future detail-card preview
(architecture-ready only) · full Ink test-suite port · removing Ink.

## Success criteria

1. Navigation is visibly smoother than Ink on real sessions (no perceptible j/k lag), even while the
   mirror updates.
2. The target visual language is achieved: distinct panels, color-coded status, hierarchy, mouse,
   discoverable vim keybindings.
3. `attach` works end-to-end against a live session.
4. Decision output: keep + expand to full migration, or discard the flag branch — with a clear verdict on
   feel and effort.

## Verification verdict (2026-06-20)

Implemented via subagent-driven execution against **OpenTUI 0.4.1** (Bun 1.3.14). Automated verification **PASS**:

- **Tests:** 83/83 TUI tests pass (existing Ink suite + new `shared/`, `attached`, and the render+nav smoke test), 10/10 CLI dash tests pass. The smoke test confirms the OpenTUI app mounts and `j` moves the `▶` selection row-to-row via `testRender` + `act`.
- **Typecheck:** clean across all 7 workspace packages.
- **Packaging:** `bun build --compile` succeeds (676 modules → 71 MB binary); both `AGMUX_TUI=opentui agmux dash` and the default Ink `agmux dash` load the bundled module graph and hit the TTY guard gracefully in the compiled binary — **OpenTUI's native core bundles into the standalone executable** (the main packaging risk is cleared).
- Resolved risks: test-renderer API pinned (`testRender`+`act`); per-file `@jsxImportSource` pragma coexists with Ink's `react` JSX; `EventEnvelope.kind` (not `type`) corrected during impl.

**Still requires a human (needs a real TTY + live hub with sessions)** — the interactive A/B in success criteria 1–3:
- Smooth nav vs Ink under a live, updating mirror.
- Visual language on a real terminal (panels/colors/hierarchy/mouse).
- `⏎` attach end-to-end against a live session; `x`+`y` kill; `q` restores the terminal.

Run: `AGMUX_TUI=opentui agmux dash` against a running hub, A/B against plain `agmux dash`, then record the keep/expand-or-discard decision here (success criterion 4).

## Risks / open items

- Interactive feel + attach/kill/quit lifecycle on a real TTY — pending human A/B (see verdict above).
- Attached-session detection heuristic reliability (best-effort; non-blocking).
- `:` command palette and the future detail-card preview are deferred (architecture is ready for the latter).
