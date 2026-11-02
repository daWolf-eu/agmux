# Rex behaviour findings (2026-11-02)

Measured on Rex server `0.0.1793299046-g2307b7`, app Rex Beta 0.1.0 (1696), macOS, in one throwaway session (`agmux-spike`, killed afterwards). Floats were created with `session.new_layer`, since keys can't be pressed from an agent.

## R1: tail read on long scrollback. PASS (p95 50 ms)
- `rex block call format '{"format":"text","max_bytes":4096}'` returns `{content, id, total}`. `content` is the HEAD of the scrollback (first ~4 KB), not the tail. `id` appears only when more remains. `total` is the byte length of the whole text.
- `blob_read` takes `{id, offset, max_bytes}` (all optional; id 0 or missing means the newest result; max_bytes counts the JSON-encoded string, default 48 KiB, cap 960 KiB). It returns `{id, data, total, eof}`.
- Scrollback of 4,271,436 bytes (100k lines of 80 chars): `format` p95 50 ms (41-50), `blob_read` at `total-65536` p95 32 ms, 10 runs each, each as a separate `rex` process (includes process start).
- With 700k short lines the retained text was only 672,179 bytes, so scrollback is capped by lines (about 96k) rather than bytes; wider lines gave 4.1 MiB.
- Asking for 65536 bytes at `total-65536` returned 57,344 or 64,096 bytes with `eof:false`. The reader must loop until `eof`.
- The `format` result id is kept ~5 minutes.

## R4: endpoint. PASS
`rex -S "$REX_SERVER" --autostart=false ls --json` works with the `unix://...%20...` value. Shape: `{"sessions":[{"session_id","label"}]}`. Exit codes: present 0, gone session/block 3, unreachable server 4. `rex block inspect` and `rex focus` need `-s` when the target block is not in `$REX_SESSION`.

## R5: argv. PASS without `--shell=none`
`rex window new --json -- /bin/sh -c 'printf "<%s>\n" "$@"; sleep 30' x 'a b' ';' '{"k":"v w"}'` printed `<a b>`, `<;>`, `<{"k":"v w"}>`. Everything survives. With `--shell=none` the same argv also survives, but PATH is `~/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:` plus cryptex and Rex app dirs, with no `/opt/homebrew/bin` or nvm. The default (login shell) PATH is the full one. `REX_SESSION`, `REX_BLOCK`, `REX_SERVER`, `REX_BIN_DIR` are set in both. A block whose program exits is closed at once and its id becomes "not found" (so wrappers need a hold on failure).

## JSON shapes (for later tasks)
- `rex new NAME --json`: `{"session_id","initial_windows":[{"window_id","block_ids":["block:.."],"revision"}]}`
- `rex window new --json -- cmd` and `rex run --json -- cmd`: `{"window_id","block_ids":["block:.."],"revision"}`
- `rex split --json -- cmd` and `rex run --split=right --json`: `{"anchor_id","block_ids":[..],"split_ids":["split:.."],"revision"}`. `--split` takes a direction value (`--split=right`); a bare `--split` swallows the next flag.
- `rex run --label L --json`: the label is NOT echoed. Ids only (`window_id`, `block_ids[0]`). The label shows as `label` in `rex block ls --json` and `session inspect` blocks. Default label is `shell`.
- `rex run --wait --json`: prints the creation result, then exits with the child's exit status (3 for `exit 3`) and `Error: exit status 3` on stderr.
- `rex block ls -s S --json`: `{"blocks":[{block_id,label,creator_name,flavor,host_id,placement,window_id,owner?}]}`.
- `rex api call -s S block.event -` with stdin `{"session_id","block_id","event":{"type":"paste","payload":{"text":...}}}` returns `{}` and exit 0. Pasting 20,400 bytes of multi-line text (200 lines with quotes, backslashes, `$`, backticks, `;|&`, non-ASCII) into `sh -c 'cat > file'` produced a byte-identical file. Lines were under 1 KiB each; a single line over the tty's 1024-byte canonical limit was not tested (needs manual check if it matters).
- `rex whoami --json`: `{principal:{kind,transport,display,uid,gid,pid}, account, endpoint, pid, instance_id, host_id, started_at, rex_version, exit_empty, session_count, tailscale:{state,allow_tailnet_members}, session_id, window_id, block_id}`. The last three are the caller's location and are present only when inside Rex.
- `rex ls --json`: `{"sessions":[{"session_id","label"}]}`.
- `session.new_layer` input: `{session_id, window_id?, bounds:[x,y,w,h], focus, layout:{block:{flavor, label, options:{command:[..], shell:"none"}}}}`; returns `{layer_id, block_ids, revision}`.

## R6, R7: floats
- Inside a float, `$REX_BLOCK` IS the float's block id and `$REX_SESSION` is the session. No `TMUX*` variables.
- `rex session inspect` shows the float as a layer `kind:"floating"` and the window's `focused_block_id` is the float (when created with focus true). The tiled layer is `kind:"tiled"` with its `blocks`. The block's window is `.block.window_id` in `rex block inspect`.
- `owner`: the float block had NO `owner`. In my throwaway session no app was attached; the clients list showed the app (`Rex Beta`, connected, but owning none of my blocks) and the CLI. The first tiled block had `owner: client:...5314...`, a CLI client that no longer existed (the one that ran `rex new`), while later tiled blocks had none. In the user's own app-attached sessions every block, including a `scratch` block, has `owner` = the app's client id. Whether a float in an app-attached session has an owner: needs manual check.
- Focus: from inside the float, `rex focus <tiled>` moves focus to the tiled block, and after the float exits focus stays there. If the float exits without that, focus does NOT return to the previously focused block. With tiled blocks B (focused), T2, T3 (newest), closing a float always left focus on T3, the most recently created tiled block, whether B or T2 had been focused before. A float created with `focus:false` leaves focus alone.

## L4: TMUX leak. NOT TESTED, NEEDS MANUAL CHECK (see the smoke results, item 12)
L4 is a Rex server autostarted from inside tmux leaking `TMUX` into its blocks. That needs starting a server from tmux and was not done, to avoid touching the real server. What was observed: this server's blocks (default shell, `sh -c`, float) have no `TMUX*` variable, with `TERM=xterm-256color`, `TERM_PROGRAM=rex`. That says nothing about the autostart case. Added to Task 13's smoke step.

- Focus of the tiled layer while a float is in front: not exposed. `session inspect` and `session.view` give `focused_block_id` per window only (the float), layers have just `layer_id, kind, bounds, layout, blocks`, blocks have no focus marker, `session.list_blocks` is the same list with `window_id`/`owner`, and `rex events` only emits `session_view_changed` with a revision. Verified with two tiled blocks plus a float. Plan Task 5 now states first-tiled-block as a deliberate degradation. Correction to the paragraph above: focus set from inside the float sticks after it exits; only an exit without that goes to the newest tiled block.

## R2: title polling. PASS
20 sequential `rex block call title`: 26-30 ms each, 554 ms total, mean 28 ms. No lower bound on the poll interval from this; 500 ms is fine.

## Needs manual check (for the final smoke test)
1. Owner of a float's block in a session an app is attached to, and `session.select` of that owner.
2. The real float key (`init.lua`), as opposed to `session.new_layer`: same `REX_BLOCK`/focus behaviour expected.
3. A single pasted line longer than 1024 bytes into a non-bracketed-paste program.

# Smoke results (2026-11-02, Task 13)

Real Rex server `0.0.1793299046-g2307b7`, app Rex Beta 0.1.0 (1696), tmux 3.6a, macOS, branch `feature/rex-multiplexer`.

## How it was isolated

- agmux ran from the worktree with a temp `HOME`, so its own hub (ephemeral port) and database. `os.homedir()` and `agmux hub status` confirmed this before the first run.
- The agent was a stub: a small raw-mode TUI with the `❯` glyph, bracketed paste, ctrl+a/k, enter and an OSC title. No paid agent ran.
- A `rex` guard shim on `PATH` logged every call, refused any session outside an allow-list of those created for the test, refused every `server` command, and swallowed every `-C` / `session.select` while logging its argv. A `tmux` guard forced the private socket `-L agmux-smoke` with its own config.
- Result: 814 Rex calls; the only 2 refusals were the guard's own self-tests; 6 `session.select` calls were swallowed. The real Rex server, hub and notifyd kept their pids, and the user's sessions were left alone. All throwaway sessions, the tmux server and the hub were removed.

**So nothing here shows the app switching.** Where a result says "select argv correct", the guard saw the right `session_id` and `window_id` and the call was dropped. The throwaway sessions also had no app attached, and floats came from `session.new_layer`, not the real key.

## Spec §7 smoke list

| # | Item | Result | Detail |
| --- | --- | --- | --- |
| 1 | `agmux run` inline and all placements, with and without `-d` | PASS | Inline, `--new-pane`, `--new-window`, `--new-session`. Rows have `mux=rex`, session, window, block, endpoint and label. Focus follows without `-d` and stays with it. `--new-session` without `-d`: select argv correct; the app moving is NEEDS MANUAL CHECK. |
| 2 | Native `claude` in a Rex tab | PASS (simulated), NEEDS MANUAL CHECK | The real SessionStart hook command ran in a real block (`agmux emit --from=claude`, `CLAUDE_CODE_SESSION_ID` set): `origin=native`, `mux=rex`, coordinates and label right. To do: start a real `claude` in a Rex tab, then check `agmux ls` shows `rex:<label>`. |
| 3 | Float: open in the same tab, another tab, another session | PASS for focus, NEEDS MANUAL CHECK for the app | Float closes onto the target, focus lands on it and stays after the close, select argv correct in all three. To do: press the real key and confirm the app moves to another session. |
| 4 | Float: live tmux session, ⏎ again | PASS | One `agmux:tmux:<hash>` tab across repeated opens (and 13 to 13 blocks from the CLI). The second open moved the tmux client to the row's window and pane. |
| 5 | Close and resume, Rex and tmux rows | PASS | Same `session_id`, new block, in a new tab of the current session. Stale-live (wrapper and agent SIGKILLed, block closed, row still `idle`) also resumes. A tmux row resumed from Rex moves to `mux=rex` and a Rex row resumed from tmux moves to `mux=null`, with every location field replaced. |
| 6 | `--prompt` with a multi-line prompt | PASS after a fix | A 3.1 KB prompt (quotes, `$`, backticks, backslash, non-ASCII, a blank line, a 3,000-byte line) arrived byte-exact. A short multi-line prompt reports `prompt injected`. The long one reports `submit unconfirmed` against the stub only, because its wrapped draft pushes the glyph out of the 5-line tail; the submit did land. Bug 1 below. |
| 7 | Preview on long scrollback | PASS | 7.7 MiB block, 12 reads of a 64 KiB tail: 135 to 205 ms through the guard, under the 250 ms target, tail correct. Also live in the dash float. |
| 8 | Open a Rex session from a plain terminal and from tmux, app running and quit | PASS, FAIL (open) and NEEDS MANUAL CHECK | Live row: `opened in Rex`, exit 0, from both. Closed row from tmux resumes in tmux. Closed row from a plain terminal: PASS with a plain env, **FAIL with the user's real shell env**: bug 3, open. App quit: NEEDS MANUAL CHECK: quit Rex, then `agmux attach <id>` should report `Rex app not running` and not resume. |
| 9 | Float: resume `new-pane`, agent survives | PASS | The agent lands in the tiled layer and survives the float closing. With `AGMUX_REX_ORIGIN_BLOCK` set to a block that isn't first, `split -b` used that block. |
| 10 | Remote session from the float, detach | NEEDS MANUAL CHECK, not run | Needs a sandbox; none here. To do on the homelab: open a remote session from the float, detach, confirm the tab closes and a second ⏎ dedups. |
| 11 | tmux behaviour unchanged | PASS, with one deliberate change | Placements, attach and resume on the private server, plain `agmux run` making the `agmux` session, and the full test suite, whose tmux tests needed no edits. Bug 2 below is the one tmux behaviour change. The attach of a live tmux row from tmux exited 0, but the client was already on that pane, so it shows little. |
| 12 | L4: autostart from inside tmux | NEEDS MANUAL CHECK, deferred by decision | Deferred to a manual check by decision: this test must not start a second Rex server. To do: with no Rex server running, start one from a tmux pane, and check `env \| grep TMUX` in its blocks is empty. If it leaks, no fallback is decided: preferring `REX_BLOCK` would misdetect every tmux-in-Rex pane, which carries stale `REX_*` with `TMUX` set, so a leak needs its own discriminator. |

## Other checks against real Rex

| Check | Result | Detail |
| --- | --- | --- |
| Existence probes | PASS | Present 35 ms; gone block; gone after the whole session was killed (also exit 3); no socket: unreachable; a socket that never answers: unreachable, bounded at 2 s; missing binary: unreachable. No server was autostarted. |
| Unreachable row | PASS | `agmux attach`, with and without `--placement`: exit 2, `Rex server unreachable; not resuming`, no block created. |
| `block send-key` names | PASS | `ctrl+a`, `ctrl+k`, `enter`, `ctrl+c` reach the agent as `0x01`, `0x0b`, `0x0d`, `0x03`, and several keys in one call work. |
| Rex block with `REX_*` | PASS | `detectMux` gives `rex`. |
| tmux-in-Rex pane | PASS | Panes carry stale `REX_*` with `TMUX` set. Wrapper and native rows both record tmux coordinates and `mux=null`. |
| Native title | PASS | notifyd read the block's `title` and posted `title.changed`. |
| `agmux seen --pane <block>` | PASS | A `done` row goes to idle; a row that isn't `done` is left alone. |
| `agmux kill` on a Rex row | PASS | Signals the pid. |
| Dash in a float | PASS | Renders, searches and previews; the `A` picker shows inline disabled (`in popup`) and new pane, window and session enabled. |

## Answers to the earlier manual checks

1. Owner of a float's block in an app-attached session, and `session.select` of it: still NEEDS MANUAL CHECK. `chooseApp` falls back to the sole connected app, which is what happened here.
2. The real float key: still NEEDS MANUAL CHECK.
3. A pasted line over 1024 bytes: a raw-mode program gets it all (the 3,000-byte line above). A cooked-mode one loses it: pasting 3,000 bytes plus a short line into `sh -c cat` wrote nothing, while a 900-byte control came through. That's the tty's canonical limit, and agents read raw.

## Bugs found

1. **Fixed: large input deadlocked the wrapper.** Only about 2 KB of the 3.1 KB prompt arrived, and the wrapper, agent and heartbeat then froze for good; the wrapper's stack was in `__write_nocancel`. The stdin pump wrote to the PTY master synchronously, so with the child's input queue full and the child blocked writing output, the event loop that drains that output was stuck. It needs an agent that redraws while it reads. It predates Rex and applies to tmux pastes too. `ptyWriter` now writes asynchronously, in order. Regression test: `packages/wrapper/tests/pty.test.ts`.
2. **Fixed: a wrapper started in the background recorded the active pane.** `display-message` without `-t` answers for the active pane, even for a caller in another one, so two `-d` rows recorded `%0` instead of `%1` and `%2`. It predates Rex. The wrapper now targets `$TMUX_PANE`, as native hooks already record. Regression test: `packages/wrapper/tests/tmux-coords.test.ts`.
3. **Open: a large environment breaks the wrapper's tmux start.** Outside any multiplexer, `newAgmuxWindow` passes the whole environment as `-e` flags, and tmux refuses a command over about 16 KB (`command too long`; 15,000 bytes passed, 16,500 failed). The user's login shell has 18.8 KB, 12.7 KB of it `LS_COLORS`, so a wrapped launch or a resume of a wrapper row from a plain terminal dies with an uncaught `ShellError`, leaving an empty `agmux` session. It predates Rex and no Rex path reaches it. Stays unfixed in this branch by decision, and is documented as a known issue in the README and CHANGELOG. `reexecEnv` documents full forwarding as deliberate and each fix is a decision: an env file puts secrets on disk, a denylist changes the agent's env, a cap trims unpredictably.

Also from the audit: `resume-nearest` handed a Rex row's ids to tmux and exited 0. It now refuses the row (fixed, with a test).

