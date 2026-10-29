# AGENTS.md — `@agmux/cli`

Remote (sandbox) attach, Phase 2. Design: `docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md` §8 and its "Phase 2 implementation notes". Remote run and resume, Phase 3: `docs/superpowers/specs/2026-10-28-remote-sandbox-control-design.md` and its "Implementation notes" (sections below). Remote `kill` stays refused (`src/remote-guard.ts`).

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

View mode builds a plain session `agmux-view-<id8>-<tag>` (never grouped: tmux 3.6a segfault), links the agent's window, binds the detach key in the server-wide key table `agmux-view` plus tmux's default mouse bindings (`MouseDown1Pane` select-pane, `MouseDrag1Pane`/`WheelUpPane` copy-mode; a session `key-table` replaces root for mouse events too, so without them clicks and the wheel do nothing), sets `destroy-unattached on` only on the attach command line, client `tmux -u`.

## Reap state

`$HOME/.agmux/attach/<tag>`, one line: `view <socket|-> <view-name>` or `full <socket|-> <client-pid>` (full mode records `$$`, then `exec`s tmux, so the pid is the client's; view mode records before building the view, so a crash mid-build stays reapable). Reap kills the view session, or the pid only while `ps -o comm=` is a tmux AND `ps -o args=` contains `attach-session` (the pid may be reused after a sandbox restart; the server must never match). Every script reaps its tag first.

Triggers: SIGHUP/SIGTERM on the pane process (unsets the pane options, SIGHUPs the openshell child, which shares the tty with the hold, then awaits the reap before exit, codes 129/143); a non-zero transport exit; the next attach with the same tag (covers a Mac crash or sleep). On openshell 0.1.5 the remote side of a `--tty` exec is hung up when the local client dies, so the hangup reap is a safety net there (observed in the Phase 2 smoke test); 0.0.116 left it running.

## tmux/ps quirks the scripts handle

- `tmux display-message -t <missing window>` exits 0 with empty output (observed on tmux 3.6a and 3.7c): the window check compares the printed `#{window_id}`, not the status.
- macOS `ps -o comm=` prints the full exec path (Linux the basename): the full-mode reap matches `tmux*` or `*/tmux`. On Linux the server's comm is `tmux: server` and a client's `tmux: client` (tmux's prctl `setproctitle` changes comm only), so comm alone cannot tell them apart: the `args` check (`*attach-session*`) does. args keep the original command line: the client's is the script's own `exec tmux … attach-session …`; the server's is that of the command that started it (`new-session`; `attach-session` never starts a server).

## Remote run and resume (Phase 3)

The Mac never starts or relaunches an agent itself: it runs the sandbox's own agmux over `transportArgv(spec, cmd, {tty: false})` (stdin ignored, output captured, 60 s timeout), then waits for the replicated row and opens it with the Phase 2 attach. Every value is its own argv element; nothing is shell-joined.

Contract (Mac ↔ sandbox argv, `src/run-remote.ts` `sandboxRunArgv`, `src/resume-remote.ts` `sandboxResumeArgv`):
- start: `<agmux_bin> run --direct --print-coords [--cwd <c>] [--prompt <t>] (-p <profile> | --kind <k> -- <command> <args…>)`. `--cwd` = CLI `--cwd`, else `[[remote]] workdir`. `--prompt-file` is read on the Mac and sent as `--prompt`.
- headless: `<agmux_bin> run --headless [--cwd <c>] --prompt <t> …` with stdout/stderr inherited; the remote exit code is the Mac's.
- resume: `<agmux_bin> attach <id> --resume-nearest --print-coords [--fallback-launch <LaunchSpec json>]`.
- success = exit 0 and stdout's last non-empty line is one `PrintedCoords` JSON line `{"remote_tmux":{"session","window","pane","socket","server"}}` (`parsePrintedCoords`, pane required); every other sandbox line goes to stderr.

Mac flow (`runRemote`, `resumeRemote`): validate the sandbox name (`[A-Za-z0-9._-]{1,64}`) and the local placement before anything runs; `SandboxControl.status` → `missing` is an error, `stopped` → `start`; then the version check (`HostRow.agmux_version !== AGMUX_VERSION` → `<host> runs an older agmux; restage the image (stage-agmux)`); exec; `POST /hosts/<host>/sync` (follower kick); `waitForRemoteRow` (15 s, 500 ms) for a row on the host matching the printed pane + window, + server when printed non-null (`matchesPrinted`; resume also requires a live remote row). Not the session id: a direct agent's id is minted at hook registration, and a fresh relaunch (no native id / zero turns) registers a new one. On timeout the agent still runs: the error carries an `agmux ls --host <host>` hint. `-d` skips the wait and the attach. Resume additionally needs the host row (`/hosts`: transport, `[[remote]]` name) and refuses a removed host or missing sandbox (`sandbox <host> is gone; cannot resume`, no recreation) and a live row (a headless one would run twice). Old-agmux fallbacks behind the version check: `run` exit 2 with `cannot infer agent_kind from '--direct'|'--print-coords'`; `attach` exit 0 without a coords line (an old attach ignores the flags).

Launch: CLI flags > `[[remote]]` (`kind`/`profile`/`command`/`args`, `resolveRemoteLaunch`); `-p` names a sandbox-side profile. Resume fallback for a row without a recorded launch: `{profile, command: command ?? kind ?? row.agent_kind, args}` (`fallbackLaunch`).

Sandbox side:
- `run --direct --print-coords` (`src/run.ts` `runPrintCoords`): requires a ready adapter (else exit 2 with the install hint, never wrapped); a detached window in `$AGMUX_TMUX_SESSION` (default `agmux`) on the default socket, the session created if missing; never `switch-client`. Prints coords with `socket: null` and the pane's server id, then injects `--prompt`.
- `attach <id> --resume-nearest --print-coords [--fallback-launch]` (`src/resume-nearest.ts`): refuses a remote row; a live row still in place (pane exists on the recorded server) prints its coords and starts nothing. Otherwise `buildDirectRelaunch` (native resume via the adapter, recorded launch → fallback launch → row as is; no `AGMUX_SESSION_ID`: the hooks re-register by native id) placed by `pickNearest`: split into the old window only if the running server's id equals the row's `tmux_server` and the window exists; else a new window in the old session (by name); else a new session with that name (`agmux` if none). All detached, on the row's socket.
- `AGMUX_LAUNCH` (`@agmux/protocol` `LaunchSpec` `{profile, command, args}`): set on every direct start (`buildDirectSpawn`) and direct relaunch; `emit` copies it onto `session.registered` (`enrichLaunch`), so the row records the real launch instead of the hook default (`command = agent_kind`, `args = []`). The projection only replaces that default, never a recorded launch.
- Server identity: `TMUX_SERVER_ID_FMT` `#{pid}-#{start_time}` (`emit` at registration, falling back to `$TMUX`'s pid; `tmuxServerId` in `run`/resume; the view/full scripts).

tmux placement (`src/tmux-place.ts`), both found by the remote e2e: calls that parse tab-separated formats run `tmux -u` (a `sandbox exec` client has no UTF-8 locale, and tmux then prints a tab as `_`); `newSession` passes the env as `env K=V … cmd`, not `-e` (which sets the session environment every later window in that session inherits).

## Known limits

- Tags (`p<N>`) share one sandbox state dir: two Macs, or two local tmux servers, using the same pane id can reap each other's client.
- A detach key bound earlier stays in the server-wide `agmux-view` key table until the sandbox tmux server restarts.
- After a normal full-mode exit the state file stays; the next reap of that tag clears it.
- Stale coords after a sandbox stop/start: the old row stays live until the sandbox hub's lost-sweep (≈30–60 s). The coords' server id (`remote_tmux.server`) makes the view/full scripts exit 3 instead of opening the new agent that reuses `@0`; such a live-but-stale row is not auto-resumed (resume works once it reads lost). Rows without a server id keep the old window-only check.
- After `/exit` a direct claude row reads live until the sandbox hub's pid sweep (≤ 30 s, no end hook): an attach then fails cleanly, a resume works after the sweep has replicated.
- A sandbox exec's prompt with newlines is passed as one argv element; verified only through the fake openshell.
- A tmux whose `setproctitle` rewrites argv (e.g. built against libbsd) shows its title in `ps -o args=` too: the full-mode reap then never matches (fails safe: no kill; on openshell 0.1.5 the transport hangup still ends the client). A server started by a command line that contains `attach-session` (e.g. `tmux new -d \; attach-session`) would match.
- A live remote row without `remote_tmux` (e.g. a headless run in the sandbox) has nothing to attach: `attachKind` is `none`.

## Tests

`tests/agmux-tmux.test.ts`, `tests/remote-tmux-scripts.test.ts`, `tests/e2e/remote-attach.test.ts`, `tests/e2e/remote-control.test.ts` need a real `tmux` (CI installs it). `remote-control.test.ts` runs remote run/resume against `tests/e2e/stub-claude.sh` (fires the claude plugin's hooks through `$AGMUX_BIN emit`, `--resume <id>` keeps the id, `-p` = headless exit 3, logs its argv and prompts to `$HOME`); it marks an exited agent lost by posting `session.lost` to the sandbox hub (stands in for the 30 s pid sweep).
