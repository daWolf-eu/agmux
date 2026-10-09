# dash `A` attach-target popup — design

**Date:** 2026-10-09
**Status:** draft for review
**Related:** [`2026-07-08-dash-yank-field-design.md`](2026-07-08-dash-yank-field-design.md)
(popup pattern), [`2026-10-08-remote-sandbox-sessions-design.md`](2026-10-08-remote-sandbox-sessions-design.md)
§8 (remote attach modes)

## Problem

⏎ in `agmux dash` does one fixed thing per situation: switch the current tmux client to a
live session (inline), resume a closed one into a new window of the caller's session, or
hand the terminal over when not in tmux. There is no way to say *where* the session should
open — inline, a new window, a new tmux session, a quick peek, a new terminal tab/window —
and remote sessions add a second choice (transparent view vs full remote tmux).

## Decision

- **`A`** opens a popup listing every attach target for the selected row, styled and driven
  like the `y` yank popup: fixed digit slots, `j/k` + ⏎, `esc` closes.
- **⏎ stays a one-key default**, resolved from config per situation (below). `A` is for
  "this time, differently".
- Same targets on the CLI: `agmux attach <id> --placement <p> [--mode <m>]`. The dash
  calls the same code path; no dash-only attach logic.

## Targets (fixed slots)

Slots are stable for muscle memory. A target that doesn't apply to the row / context stays
in its slot, dimmed, with a one-word reason (yank convention).

| Key | Target | Live local session | Closed session (resume) | Remote session |
|---|---|---|---|---|
| 1 | **inline** | switch this client to the agent's pane (today's ⏎ in tmux) | agent replaces the dash's pane (dash exits, handoff argv) | dash hands its pane to the transport (dash exits) |
| 2 | **new pane** | split here, pane runs a view client (§Mechanics) | split here, agent runs in it | split here, transport runs in it |
| 3 | **new window** | new window here, runs a view client | new window here (today's in-tmux resume) | new window here, transport (remote spec §4.7) |
| 4 | **new session** | grouped session on the agent's session, switch to it (no nesting) | new tmux session, agent in it | new local session, transport in its window |
| 5 | **peek** | `display-popup` with a view client; closes on detach | — (dimmed: agent would die with the popup) | `display-popup` with the transport |
| 6 | **new tab** | terminal tab running `agmux attach <id> --placement inline` | same (resume happens there) | same |
| 7 | **new terminal window** | terminal OS window, same command | same | same |

Outside tmux only 1, 6, 7 apply (1 = today's foreground handoff). In popup-dash mode
(`display-popup -E`), 2–4 act on the parent client then close the dash popup (as
`attachInPopup` does today); 5 is dimmed until nested popups are verified.

**Remote rows** show the attach mode in the popup header — `mode: view ⇄ full (m)` —
and `m` toggles it before picking a target (remote spec §8: N1 view / N2 full). Local rows
hide the mode line.

## Mechanics

- **View client (local, slots 2/3/5).** A pane running a second client of the same tmux
  server onto a throw-away grouped session of the agent's session — the same N1 view
  session as the remote spec §8.1 (`prefix None`, `status off`, `destroy-unattached on`),
  started with `TMUX=` unset. Closing the pane kills only that client; the agent is never
  touched. Chosen over `link-window`, where a habitual `kill-window` on the linked window
  would kill the agent itself.
  - If the agent's window already is in the caller's session, 2/3 would show a window
    inside itself → fall back to inline and say so in the notice.
- **Leaving a view.** The `agmux-view` key table binds exactly one key, default `M-d` →
  `detach-client` (`[attach] view_detach_key`). Needed for peek (the popup closes when its
  client detaches) and handy everywhere else; it's not a key Claude Code uses.
- **New session (local, slot 4)** needs no nesting: `new-session -d -t <agent session> -s
  agmux-<id8>` + select window/pane + `switch-client`, with `destroy-unattached on`.
- **Terminal tab/window (6/7)** go through argv templates, because there's no portable
  way to open a tab (Ghostty on macOS: verify what its CLI / AppleScript support allows):

  ```toml
  [terminal]
  new_window = ["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"]
  new_tab    = []          # unset → slot 6 dimmed ("not configured")
  ```

  `{cmd}` expands to `agmux attach <id> --placement inline [--mode …]`, so the new
  terminal resolves fresh coordinates itself.
- **Resume placements** reuse the existing `agmux run` placement code
  (`tmux-place.ts`: new-pane / new-window / new-session) — resume already goes through
  `resumeIntoSession`; it gains a placement argument instead of hard-coding new-window.

## Defaults for ⏎

```toml
[attach]
live   = "inline"       # live local session
closed = "new-window"   # resume
view_detach_key = "M-d"

[remote.attach]         # remote spec §8
placement = "new-window"
mode      = "view"      # view | full
```

A configured default that doesn't apply in the current context (e.g. `new-window` outside
tmux) falls back to `inline`.

## Components

- `packages/tui/src/shared/attach-targets.ts` (new, pure): `attachTargets(row, ctx)` →
  `{ slot, key, label, enabled, reason }[]`, where `ctx = { inTmux, popup, remote,
  terminal: { tab, window } }`. Unit-tested like `yank.ts`.
- `packages/tui/src/opentui/Overlays.tsx`: extract the yank popup's list rendering into a
  generic picker; `YankOverlay` and new `AttachOverlay` both use it.
- `DashApp.tsx`: `attachOpen` / `attachCursor` / `attachMode` state, an early branch in the
  keyboard handler like `yankOpen`; `A` opens, digits/⏎ act, `m` toggles mode (remote rows).
- `types.ts`: `Actions.attach(row, req?)` / `Actions.resume(row, req?)` with
  `req = { placement, mode? }`; no `req` = configured default (today's behaviour).
- `packages/cli/src/attach.ts` + `dash-actions.ts`: one placement executor shared by
  `agmux attach --placement` and the dash; `parse` for `--placement` / `--mode`.
- Help overlay + footer hint: `A attach…`.

## Scope / phasing

1. Local: slots 1–4 + 7 (Ghostty new window), ⏎ defaults from config, `--placement`.
2. Peek (5) and new tab (6) after verification.
3. Remote rows: mode line + `m`, transport placements — lands with remote spec phase 2.

## Verify

- Same-server nested client with `TMUX=` unset onto a grouped session: no recursion when
  the agent's session differs from the caller's; behaviour when it doesn't.
- `display-popup` from a dash already running in a popup (nested popups) — or close-then-
  open via `run-shell -b`.
- Ghostty 1.3 on macOS: new window with a command (`open -na … --args -e`), and whether a
  new *tab* with a command is possible at all.
- `M-d` reaches the view's key table through the outer tmux (not bound in the outer root
  table).
