# AGENTS.md — `@agmux/cli`

Remote (sandbox) attach, Phase 2. Design: `docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md` §8 and its "Phase 2 implementation notes". Remote `kill` and `resume` stay refused (Phase 3, `src/remote-guard.ts`).

## Remote client (`src/remote-client.ts`)

`agmux attach <id> --remote-client --mode view|full --detach-key <k>` is the process that runs in the local pane (every placement spawns it). It:

1. Loads the row (`/sessions/<id>`) and the host's transport (`/hosts`); requires a live remote row with valid coords (`isRemoteTmux`).
2. Tags the pane: tag = `p<N>` from `$TMUX_PANE` (`%N`), else `t` + 8 random hex chars. Sets pane options `@agmux_session_id`, `@agmux_remote=1`, `@agmux_attach_mode` (used for dedup, focus-seen, styling).
3. Starts a Stopped sandbox (`sandbox get -o json`, `phase === "Stopped"` -> `sandbox start`; a failing `get` is ignored).
4. Runs the view/full script over `exec --tty` in the foreground.

Plain local `agmux attach` never reads config; remote rows load `[attach.remote]` lazily (a broken config prints a warning and uses defaults).

## Fixed sh scripts (`src/remote-tmux.ts`)

`VIEW_SCRIPT`, `FULL_SCRIPT`, `REAP_SCRIPT` are string constants run as `sh -c <SCRIPT> agmux <args...>`. Row values are positional args only: copied to named variables on the first line, always expanded double-quoted. No `eval`, nothing spliced into the script text. The sandbox needs only sh + tmux. Exit codes: 0 normal, 3 target gone / view not buildable (stderr message), else tmux's.

Validation (before any value is used; `isRemoteTmux`, `isAttachTag`, `isTmuxKeyName`):
- `session_id`: `isShellSafeId` (`[0-9a-f-]+`; the canonical-UUID check `SESSION_ID_RE` is used for the pane option and ingest).
- tag `^[A-Za-z0-9_-]{1,32}$`; detach key `^[A-Za-z0-9-]{1,16}$`.
- window `^@\d{1,9}$`; pane `^%\d{1,9}$` or null.
- socket null or `^/[A-Za-z0-9._/-]{1,255}$`.
- tmux session name 1-128 chars, no control chars, no `:` or `.`.
- Window names (`window_name`, `{title}`) pass `stripControls`, every `#` doubled, `{title}` capped at 40 columns; a trailing `;` is escaped as `\;` (tmux argv separator).

View mode builds a plain session `agmux-view-<id8>-<tag>` (never grouped: tmux 3.6a segfault), links the agent's window, binds the detach key in the server-wide key table `agmux-view`, sets `destroy-unattached on` only on the attach command line, client `tmux -u`.

## Reap state

`$HOME/.agmux/attach/<tag>`, one line: `view <socket|-> <view-name>` or `full <socket|-> <client-pid>` (full mode records `$$`, then `exec`s tmux, so the pid is the client's). Reap kills the view session, or the pid only while `ps -o comm=` is a tmux. Every script reaps its tag first.

Triggers: SIGHUP/SIGTERM on the pane process (awaits the reap before exit, codes 129/143); a non-zero transport exit; the next attach with the same tag (covers a Mac crash or sleep).

## tmux/ps quirks the scripts handle

- `tmux display-message -t <missing window>` exits 0 with empty output (observed on tmux 3.6a and 3.7c): the window check compares the printed `#{window_id}`, not the status.
- macOS `ps -o comm=` prints the full exec path (Linux the basename): the full-mode reap matches `tmux*` or `*/tmux`.

## Known limits

- Tags (`p<N>`) share one sandbox state dir: two Macs, or two local tmux servers, using the same pane id can reap each other's client.
- A detach key bound earlier stays in the server-wide `agmux-view` key table until the sandbox tmux server restarts.
- After a normal full-mode exit the state file stays; the next reap of that tag clears it.

## Tests

`tests/agmux-tmux.test.ts`, `tests/remote-tmux-scripts.test.ts`, `tests/e2e/remote-attach.test.ts` need a real `tmux` (CI installs it).
