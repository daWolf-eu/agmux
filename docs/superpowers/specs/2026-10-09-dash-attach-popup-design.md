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
| 2 | **new pane** | — (dimmed: already open) | split here, agent runs in it | split here, transport runs in it |
| 3 | **new window** | — (dimmed: already open) | new window here (today's in-tmux resume) | new window here, transport (remote spec §4.7) |
| 4 | **new session** | — (dimmed: already open) | new tmux session, agent in it | new local session, transport in its window |
| 5 | **peek** | planned: `display-popup` with a view of the agent's window | — (dimmed: agent would die with the popup) | `display-popup` with the transport |
| 6 | **new tab** | terminal tab running `agmux attach <id> --placement inline` | same (resume happens there) | same |
| 7 | **new terminal window** | terminal OS window, same command | same | same |

Outside tmux only 1, 6, 7 apply (1 = today's foreground handoff). In popup-dash mode
(`display-popup -E`), 2–4 act on the parent client then close the dash popup (as
`attachInPopup` does today); 5 is dimmed until nested popups are verified.

**Remote rows** show the attach mode in the popup header — `mode: view ⇄ full (m)` —
and `m` toggles it before picking a target (remote spec §8: N1 view / N2 full). Local rows
hide the mode line.

## Mechanics

- **Live local agents are only switched to (decided 2026-10-09).** A live agent can't move,
  so opening it in a new pane/window/session would need a second view of its window. The
  first build did that with a client on a throw-away *grouped* session; dropped because:
  - tmux 3.6a segfaults when a session of a group loses its last window
    (`server_destroy_session_group` → `session_destroy` → `notify_session` →
    `cmd_find_from_nothing`) — an agent alone in its session exiting while a view is open
    takes the whole tmux server down;
  - switching to where the agent runs needs no workaround, and new tab/terminal still give
    a second place to look (`agmux attach` there).

  A future view (peek, remote N1) links the agent's window into a plain session instead
  (`new-session -d -s V` + `link-window -s <win> -t V:` + kill V's first window): no group,
  verified not to crash on agent exit or `kill-window`.
- **A placed command that fails keeps its pane** until a key (`holdOnFailure`), so a resume
  whose cwd is gone shows its error instead of flickering.
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
live   = "inline"       # live local session: inline | new-tab | new-terminal
closed = "new-window"   # resume

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

1. Local: slot 1 for live, 1–4 for closed, 6/7 via `[terminal]`, ⏎ defaults from config, `--placement`.
2. Peek (5) and new tab (6) after verification.
3. Remote rows: mode line + `m`, transport placements — lands with remote spec phase 2.

## Verify

- `display-popup` from a dash already running in a popup (nested popups) — or close-then-
  open via `run-shell -b`.
- Ghostty 1.3 on macOS: new window with a command (`open -na … --args -e`), and whether a
  new *tab* with a command is possible at all.
- Peek: a `link-window` view inside `display-popup`; what leaves it (popup close vs a
  detach key).
