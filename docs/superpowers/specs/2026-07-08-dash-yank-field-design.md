# dash `y` yank-field popup — design

**Date:** 2026-07-08
**Branch:** `feature/dash-command-yank-field`
**Status:** approved

## Problem

There is no way to copy a specific field of a session from `agmux dash`. Users
open the dash, find an entry, and want a value (session id, cwd, native id,
command, …) on the system clipboard. Marking text in the preview pane and copying
it does not work reliably, and would be poor UX even if it did.

We want a vim-style **`y`** (yank) command that opens a small popup listing the
most relevant fields of the currently selected entry, each prefixed with a digit
`1`–`0`. Pressing the digit — or navigating the list and pressing Enter — copies
that field's value to the system clipboard.

## Background (current architecture)

- **`agmux dash`** is an OpenTUI/React TUI. `packages/tui/src/opentui/DashApp.tsx`
  owns all state and a single `useKeyboard` handler. Modal state is already
  handled by early branches in that handler (`searching`, `confirmKill`,
  `showHelp`) checked before the global keys, plus early-return overlays in the
  render (`showHelp` replaces the screen; `confirmKill` shows in the footer via
  `notice`/`FooterBar`).
- **Detail preview** (`packages/tui/src/opentui/PreviewPane.tsx` → `DetailBody`)
  already builds a `[label, value][]` list of ~18–21 fields from the selected
  `SessionRow` (+ async usage). This is the field source a yank popup draws from.
- **Side effects are dependency-injected**: `PreviewSource` (`mirror`/`usage`)
  and `Actions` (`attach`/`kill`/`resume`) are interfaces in
  `packages/tui/src/types.ts`; concrete impls live in cli
  (`dash-preview.ts`, `dash-actions.ts`) and are passed into `DashApp`. The TUI
  itself never shells out (except `attached.ts` pane probing), which keeps it
  unit-testable with fakes.
- **Shelling out** elsewhere uses `Bun.spawn(["tmux", …])` with injectable seams
  for tests (`dash-preview.ts`, `tmux-inject.ts`).
- `SessionRow` fields: `packages/protocol/src/session.ts`.
- The dash frequently runs inside a tmux `display-popup`, and may be used over
  SSH — the clipboard mechanism must not assume a local macOS terminal.

## Decisions (from brainstorming)

1. **Autodetecting clipboard** — works across local macOS, local Linux, and
   remote/SSH without configuration.
2. **Fixed digit→field slots** — the mapping is stable for muscle memory. Empty
   fields keep their slot (shown dimmed); yanking an empty field copies nothing
   and shows a notice.
3. **Row fields only** — the 10 fields come purely from `SessionRow`, so the
   popup is deterministic and never depends on the async usage buffer.

## The 10 fields

Fixed order, mapped to digits `1`–`9` then `0`:

| Key | Label      | Value                                             |
|-----|------------|---------------------------------------------------|
| 1   | Session ID | `session_id`                                      |
| 2   | Native ID  | `native_session_id`                               |
| 3   | CWD        | `cwd`                                             |
| 4   | Command    | `[command, ...args].join(" ")`                    |
| 5   | Project    | `project`                                         |
| 6   | TMUX       | tmux target (see below)                           |
| 7   | PID        | `String(pid)`                                     |
| 8   | Host       | `host`                                            |
| 9   | Profile    | `profile`                                         |
| 0   | Parent ID  | `parent_session_id`                               |

- A field is **empty** when its computed value is `""` (after `trim()`). Nullable
  columns (`native_session_id`, `project`, `pid`, `profile`, `parent_session_id`)
  become `""`. Empty fields are listed but dimmed and non-copyable.
- **TMUX target** mirrors `DetailBody`'s `tmuxFull` so "what you see is what you
  yank": `""` when `!tmux_session`; otherwise
  `` `${tmux_session}:${tmux_window}${tmux_pane ? " " + tmux_pane : ""}` ``.
  `tmuxFull`/`tmuxTarget` is extracted to the shared module and reused by
  `DetailBody` (`tmuxTarget(r) || "—"`) to avoid duplicating the join.

## Components

### 1. Field builder — `packages/tui/src/shared/yank.ts` (new)

Pure, no rendering, unit-testable.

```ts
export interface YankField { label: string; value: string; empty: boolean; }
export function tmuxTarget(row: SessionRow): string;   // "" when no tmux session
export function yankFields(row: SessionRow): YankField[]; // fixed 10, in order
```

`empty = value.trim() === ""`.

### 2. Clipboard writer — `packages/cli/src/clipboard.ts` (new)

```ts
export async function copyToClipboard(text: string, deps?: ClipboardDeps): Promise<void>;
```

Autodetect chain (first that succeeds wins):

1. `process.platform === "darwin"` → `pbcopy`.
2. `process.platform === "linux"` → first of `wl-copy`, `xclip -selection
   clipboard`, `xsel --clipboard --input` found on `PATH`.
3. **Fallback** (no native tool on PATH, or the spawn fails) → **OSC 52**:
   base64-encode the text and write `\x1b]52;c;<b64>\x07` to the terminal.
   When `$TMUX` is set, wrap it in tmux passthrough:
   `\x1bPtmux;\x1b` + `<seq with inner ESC doubled>` + `\x1b\\`.

`ClipboardDeps` exposes injectable seams — a `spawn` (default `Bun.spawn`), a
`which`/PATH probe, a `platform` string, and a `writeOut` (default
`process.stdout.write`) — so tests assert chain selection and OSC 52 formatting
without touching the real clipboard.

**Caveat:** OSC 52 writes an escape to stdout while OpenTUI owns the
alternate screen. It is out-of-band and normally invisible; the native path is
primary on macOS. Documented, not fought.

### 3. DI wiring

- `packages/tui/src/types.ts`: add `copy(text: string): Promise<void>` to
  `Actions`.
- `packages/cli/src/dash-actions.ts`: implement `copy` in `makeActions` by
  delegating to `copyToClipboard`.

### 4. DashApp — `packages/tui/src/opentui/DashApp.tsx`

- **State:** `yankOpen: boolean`, `yankCursor: number` (0–9).
- **Open:** global `y` — only when `selected` is non-null and no other modal is
  active — sets `yankOpen = true`, `yankCursor = 0`.
- **Keyboard branch** (added alongside `searching`/`confirmKill`/`showHelp`,
  before global keys):
  - digits `1`–`9` → `doYank(n-1)`; `0` → `doYank(9)`.
  - `j`/`down` → cursor+1 (clamped 9); `k`/`up` → cursor−1 (clamped 0).
  - `return` → `doYank(yankCursor)`.
  - `escape` / `q` / `y` → close (`yankOpen = false`).
- **`doYank(i)`:** resolve `yankFields(selected)[i]`. If `empty` →
  `setNotice(\`${label} is empty\`)`. Else `await props.actions.copy(value)` →
  `setNotice(\`copied ${label}\`)`; `.catch` → `setNotice(\`copy failed: ${msg}\`)`.
  Always closes the popup.
- **Render:** when `yankOpen`, early-return a bordered box (same pattern as the
  `showHelp` overlay) titled ` yank field `, one row per field:
  `` `${digit}  ${label}  ${value or "—"}` ``, cursor row highlighted, empty rows
  dimmed. A footer hint line (`1-0/⏎ copy · j/k move · esc close`).
- No conflict with kill-confirm `y`: the `confirmKill` branch returns before the
  global keys, and the yank popup is its own branch.

### 5. Help + footer text

Add `y yank` to the `showHelp` overlay and to `FooterBar`'s `HINT`.

## Data flow

```
y ─▶ yankOpen=true ─▶ [popup renders yankFields(selected)]
                         │
             digit / (j/k + ⏎)
                         ▼
                     doYank(i)
                    ┌────┴─────────────┐
              field.empty          not empty
                    │                   │
        notice "<L> is empty"   actions.copy(value)  ──▶ copyToClipboard
                    │            ├─ ok  ─▶ notice "copied <L>"
                    │            └─ err ─▶ notice "copy failed: …"
                    └───────────────┴──▶ yankOpen=false
```

## Error handling

- **Empty field** → notice, no copy, popup closes.
- **Clipboard failure** (`copyToClipboard` throws) → caught in `doYank`, shown as
  a notice; popup closes; dash keeps running.
- **No selection** → `y` is a no-op (popup never opens without a selected row).

## Testing

- `packages/tui/tests/shared/yank.test.ts` — `yankFields` for a fully-populated
  row (all 10 non-empty, correct order/values, TMUX target format) and a sparse
  row (nullable columns → `empty: true`, `value: ""`).
- `packages/cli/tests/clipboard.test.ts` — chain selection per platform/PATH
  (darwin→pbcopy; linux→wl-copy/xclip/xsel precedence); OSC 52 fallback byte
  sequence and tmux passthrough wrapping when `$TMUX` set — all via injected
  seams, no real clipboard.
- `packages/tui/tests/opentui/dash-app.test.tsx` (extend) — `y` opens the popup;
  a digit copies the expected value through a fake `copy` action and shows the
  `copied <Label>` notice; an empty field shows `<Label> is empty` and does not
  call `copy`; `esc` closes the popup.

## Out of scope (YAGNI)

- Usage-derived fields (Model/Tokens/Cost).
- Configurable field set / ordering.
- Copying multiple fields at once or a formatted record.
- Persisted "last yanked" memory.
