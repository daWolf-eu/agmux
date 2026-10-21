# AGENTS.md — `@agmux/cli`

Remote (sandbox) attach, Phase 2. Design: `docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md` §8 and its "Phase 2 implementation notes". Remote `kill` and `resume` stay refused (Phase 3, `src/remote-guard.ts`).

## Remote client (`src/remote-client.ts`)

`agmux attach <id> --remote-client --mode view|full --detach-key <k>` is the process that runs in the local pane (every placement spawns it). It:

1. Loads the row (`/sessions/<id>`) and the host's transport (`/hosts`); requires a live remote row with valid coords (`isRemoteTmux`).
2. Tags the pane: tag = `p<N>` from `$TMUX_PANE` (`%N`), else `t` + 8 random hex chars. Sets pane options `@agmux_session_id`, `@agmux_remote=1`, `@agmux_attach_mode` (used for dedup, focus-seen, styling).
3. Starts a Stopped sandbox (`sandbox get -o json`, `phase === "Stopped"` -> `sandbox start`; a failing `get` is ignored).
4. Runs the view/full script over `exec --tty` in the foreground.
5. When the transport exits (any code) or on SIGHUP/SIGTERM: unsets the three pane options (`set-option -p -u`, failures ignored) before the reap and before returning to the failure hold, so a held or reused pane never wins dedup or focus-seen.

New-session placement names the local session `agmux-<id8>-<mode>` (a view and a full client of one session can coexist).

Plain local `agmux attach` never reads config; remote rows load `[attach.remote]` lazily (a broken config prints a warning and uses defaults).

## Fixed sh scripts (`src/remote-tmux.ts`)

`VIEW_SCRIPT`, `FULL_SCRIPT`, `REAP_SCRIPT` are string constants run as `sh -c <SCRIPT> agmux <args...>`. Row values are positional args only: copied to named variables on the first line, always expanded double-quoted. No `eval`, nothing spliced into the script text. The sandbox needs only sh + tmux. Exit codes: 0 normal, 3 target gone / view not buildable (stderr message), else tmux's.

Validation (before any value is used; `isRemoteTmux`, `isAttachTag`, `isTmuxKeyName`):
- `session_id`: `isShellSafeId` (`[0-9a-f-]+`; the canonical-UUID check `SESSION_ID_RE` is used for the pane option and ingest).
- tag `^[A-Za-z0-9_-]{1,32}$`; detach key `^[A-Za-z0-9-]{1,16}$`.
- window `^@\d{1,9}$`; pane `^%\d{1,9}$` or null.
- socket null or `^/[A-Za-z0-9._/-]{1,255}$`.
- tmux session name 1-128 chars, no control chars, no `:` or `.`.
- `{title}` (session name, else id8) passes `stripControls`, is capped at 40 columns and has every `#` doubled. The `[attach.remote] window_name` template itself is the user's own and is format-expanded by tmux (`#{…}` works). A trailing `;` of the final name is escaped as `\;` (tmux argv separator).

View mode builds a plain session `agmux-view-<id8>-<tag>` (never grouped: tmux 3.6a segfault), links the agent's window, binds the detach key in the server-wide key table `agmux-view`, sets `destroy-unattached on` only on the attach command line, client `tmux -u`.

## Reap state

`$HOME/.agmux/attach/<tag>`, one line: `view <socket|-> <view-name>` or `full <socket|-> <client-pid>` (full mode records `$$`, then `exec`s tmux, so the pid is the client's; view mode records before building the view, so a crash mid-build stays reapable). Reap kills the view session, or the pid only while `ps -o comm=` is a tmux AND `ps -o args=` contains `attach-session` (the pid may be reused after a sandbox restart; the server must never match). Every script reaps its tag first.

Triggers: SIGHUP/SIGTERM on the pane process (unsets the pane options, SIGHUPs the openshell child, which shares the tty with the hold, then awaits the reap before exit, codes 129/143); a non-zero transport exit; the next attach with the same tag (covers a Mac crash or sleep). On openshell 0.1.5 the remote side of a `--tty` exec is hung up when the local client dies, so the hangup reap is a safety net there (observed in the Phase 2 smoke test); 0.0.116 left it running.

## tmux/ps quirks the scripts handle

- `tmux display-message -t <missing window>` exits 0 with empty output (observed on tmux 3.6a and 3.7c): the window check compares the printed `#{window_id}`, not the status.
- macOS `ps -o comm=` prints the full exec path (Linux the basename): the full-mode reap matches `tmux*` or `*/tmux`. On Linux the server's comm is `tmux: server` and a client's `tmux: client` (tmux's prctl `setproctitle` changes comm only), so comm alone cannot tell them apart: the `args` check (`*attach-session*`) does. args keep the original command line: the client's is the script's own `exec tmux … attach-session …`; the server's is that of the command that started it (`new-session`; `attach-session` never starts a server).

## Known limits

- Tags (`p<N>`) share one sandbox state dir: two Macs, or two local tmux servers, using the same pane id can reap each other's client.
- A detach key bound earlier stays in the server-wide `agmux-view` key table until the sandbox tmux server restarts.
- After a normal full-mode exit the state file stays; the next reap of that tag clears it.
- Stale coords after a sandbox stop/start: the old row stays live until the sandbox hub's lost-sweep (≈30–60 s). A new tmux server reuses the socket path and `@0`, so the window check passes and an attach of the old row opens the NEW agent. Fix needs a tmux-server identity in the replicated coords (Phase 3).
- A tmux whose `setproctitle` rewrites argv (e.g. built against libbsd) shows its title in `ps -o args=` too: the full-mode reap then never matches (fails safe: no kill; on openshell 0.1.5 the transport hangup still ends the client). A server started by a command line that contains `attach-session` (e.g. `tmux new -d \; attach-session`) would match.
- A live remote row without `remote_tmux` (e.g. a headless run in the sandbox) has nothing to attach: `attachKind` is `none`.

## Tests

`tests/agmux-tmux.test.ts`, `tests/remote-tmux-scripts.test.ts`, `tests/e2e/remote-attach.test.ts` need a real `tmux` (CI installs it).
