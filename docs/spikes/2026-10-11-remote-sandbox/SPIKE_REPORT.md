# Remote sandbox sessions — Phase 0 spike

**Date:** 2026-10-11  **Spec:** [`2026-10-08-remote-sandbox-sessions-design.md`](../../superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md) §10/§11
**Setup:** Mac (tmux 3.6a, Bun 1.3.14, openshell CLI 0.0.116) → gateway `ai-sandbox` →
the real work-item sandbox `wi-sag-280` (workbench image, `work-default` + SAG layers,
Ubuntu 24.04, glibc 2.39, x86_64/AVX2, tmux 3.7c via mise). Binaries uploaded to
`/sandbox/.spike/bin` (no image change). Every tmux test used an isolated server
(`tmux -L spike` remotely, `tmux -L agmux-spike` locally), never the sandbox's own.

**Verdict: GO for topology S.** Everything the design rests on works in the real
sandbox. Six findings change the design (§ "Design changes"); the most important is that
**`openshell sandbox exec --tty` never tears down the remote side when the local client
dies**. N1 views must be reaped explicitly.

---

## Results

| # | Question (spec §11) | Result |
|---|---|---|
| 1 | Linux build | `bun build --compile --target=bun-linux-{x64,arm64}` works from the Mac **after `bun install --os='*' --cpu='*'`**. Without it the CLI fails to bundle (`@opentui/core-linux-x64` not installed, since the dash pulls opentui's native lib). Lockfile unchanged. Sizes: `agmux` 128 MB + `agmux-hub` 95 MB per arch. |
| 2 | Runs in the sandbox | Yes, from `/sandbox` too (Landlock permits exec there). `bun:sqlite` + WAL on overlayfs fine. |
| 3 | Hub + loopback with the proxy env | Works. The env has `HTTP(S)_PROXY`/`ALL_PROXY`/`grpc_proxy=http://10.200.0.1:3128`, `NO_PROXY=127.0.0.1,localhost,::1`, `NODE_USE_ENV_PROXY=1`; Bun `fetch` to `127.0.0.1:<port>` goes direct. `agmux ls` auto-starts the hub; **the hub outlives the `exec` that spawned it** (reparented to the supervisor, pid 1). |
| 4 | Hooks → emit → hub | Works end to end with recorded hook payloads (stub agent firing the claude plugin's hook points with `CLAUDE_CODE_SESSION_ID` set): session row with git repo/branch, tmux coords incl. socket, pid. **Real claude not run**: claude in `wi-sag-280` reports "Not logged in" (see Open). The adapter installs as a skills-dir plugin (pure files); its hooks call `agmux` by `PATH`, so production needs `/usr/local/bin/agmux`. |
| 5 | In-sandbox liveness | Works unchanged: agent exits → `lost` after ~20 s (sweep, same pid namespace). |
| 6 | Hostname | Container id (`144190573f15`, `770299bf26e0`). Stored `host` is that today → `AGMUX_HOST` is required. |
| 7 | `sandbox create --env` reach | A create-time `--env` value (`DISABLE_AUTOUPDATER=1` on `wi-sag-280`) is visible in `exec` processes **and** in tmux panes started from them. Image `ENV` is not (homelab Dockerfile notes). → `AGMUX_HOST` via `--env` at create works. |
| 8 | `sandbox list -o json` | Array of `{name, id, phase, labels{}, annotations{}, created_at, current_policy_version, resource_version, workspace}`. Selector: `--selector k=v,k2=v2`. Existing sandboxes have no `agmux` label; the CLI has no label-edit verb at 0.0.116 (opt-in = recreate or a launcher change). |
| 9 | `exec` round trip Mac → ai-sandbox | 20–30 ms (`exec -- true`, 5 runs). Far below the spec's 100–300 ms estimate. |
| 10 | `exec --no-tty` streams incrementally | Yes, each line arrives within clock skew (±50 ms) of being written. |
| 11 | Idle cost / concurrency | Idle `openshell exec` on the Mac: **13.3 MB RSS** each. 20 concurrent execs: all started, all exit 0, no cap hit. 12 sandboxes ≈ 160 MB on the Mac. |
| 12 | Hub RSS in sandbox | 45 MB idle, 46 MB after events. |
| 13 | Long-lived `exec` (hours, idle gaps up to 1 h) | **Running**, see "Long-lived stream" below. |
| 14 | N1 view on remote tmux 3.7c (automated) | Works with the link-window recipe + fixes below. Keys pass through both layers (Esc single `1b`, `C-b` reaches the pane since inner `prefix None`, arrows, Shift+Enter). Agent exit under the view: **no crash on 3.7c**, view destroyed. `M-d` detaches, view destroyed, transport exits 0. |
| 15 | Extended keys across two layers | With outer 3.6a + inner 3.7c both `extended-keys on` + `terminal-features ',xterm*:extkeys'`, and the app requesting modifyOtherKeys 2: Shift+Enter arrives as `ESC[27;2;13~`, `C-c` as `ESC[27;5;99~`. The inner client sees `TERM=xterm-256color` with `extkeys` in its features. Real Claude in Ghostty still to check by hand. |
| 16 | arm64 (Mac gateway) | **Not run** — creating a sandbox on the local gateway was blocked by the session's permission policy. Binary built (`bin/arm64`). |

## Design changes (folded into the spec)

1. **`exec` lifetime depends on local stdin, and `--tty` is never torn down.**
   - `--no-tty`, local stdin **held open** (pipe): killing the local CLI (TERM/KILL)
     kills the remote command. → The puller must spawn `openshell` with a stdin pipe it
     never closes.
   - `--no-tty`, local stdin closed up front (`</dev/null`, Bun `stdin: "ignore"`): the
     remote command is **orphaned** and keeps running; its writes don't fail either (the
     supervisor keeps draining stdout).
   - `--tty`: closing the local window (SIGHUP), TERM, KILL (local exit 143/137) — the
     remote process **always survives**. An N1 view client orphaned this way stays
     attached, so `destroy-unattached` never fires, and it can pin the agent window's size.
   - → Remote `agmux events --follow` takes a per-consumer lock and replaces a previous
     follower (belt and braces next to the stdin rule). N1/N2 attach needs an explicit
     **reap** driven by the Mac: the local pane process (`agmux attach`) tags the remote
     attach and, when its pane goes away, runs `exec --no-tty -- agmux attach --reap
     <tag>` (N1: kill the view session — verified to free the orphaned client; N2: kill
     the recorded client pid). The next attach with the same tag reaps first, covering
     Mac crash/sleep. Spec §8.1.
   - **Correction 2026-10-20 (real-sandbox smoke test, openshell 0.0.116):** a stdin pipe
     held open **blocks** the `--no-tty` remote command: it starts only once the local
     stdin reaches EOF (`(sleep 6) | … exec --no-tty -- sh -c 'echo hi; sleep 2; echo
     there'` prints `hi` at +6 s; a never-closed Bun pipe prints nothing, ever; `/dev/null`
     starts at once and streams). The rule is now **closed stdin + a bounded remote
     follower**: `agmux events --follow --max-duration 3600` plus the consumer lock. Spec
     §10 R19.
2. **`destroy-unattached` must be set at attach time.** Set on the fresh, never-attached
   view session, it fires as soon as `kill-window -t V:^` runs and the view is gone
   before `attach-session` (3.7c). Fix: `attach-session -t V \; set -t V destroy-unattached on`.
3. **`exec --tty` gives no UTF-8 locale** → the inner client draws `_` for non-ASCII.
   Attach with `tmux -u`.
4. **Don't assume the agent's tmux session name.** The real sandbox's session is `0`
   (plain `tmux`), not `work`. S already resolves coords remotely (`agmux attach --view
   <id>`), so this only removes the `work` assumption from the docs.
5. **Binary delivery: two binaries, 223 MB per arch.** `agmux` spawns `agmux-hub` from
   `PATH`/`AGMUX_HUB_BIN`; `stage-agmux` must ship both (or agmux gains a `hub` entry so
   one binary serves). `stage-agmux` must run `bun install --os='*' --cpu='*'` before
   cross-compiling.
6. **Cost model is cheaper than estimated** (20–30 ms per exec, 13 MB per idle stream).
   Streaming stays the default; the poll fallback is cheap enough to back off gently.

## Other observations

- `exec` launched under `timeout(1)` with stdin left as the caller's hung before running
  the remote command (likely job-control/tty handling in the CLI; stdin `/dev/null` or a
  pipe avoids it). Not an issue for the hub (no controlling tty, stdin pipe), which the
  long-lived test exercises exactly.
- `exec` maps a remote death-by-signal to exit 1 (`kill -TERM $$` → 1), not 128+n.
  `exit 7` → 7.
- `sandbox upload <dir> <dest>` nests the directory (`dest/<dirname>/…`); file modes kept.
  223 MB uploads in ~3 s.
- `/proc/<pid>/environ` is unreadable even for the same uid inside the sandbox.
- **Unexplained, once:** the isolated remote tmux server (`-L spike`) disappeared during
  the orphan/signal tests. Four targeted replays (attached-client SIGTERM, orphaned-client
  SIGTERM, keepalive-only server, the original step order with checks after each step)
  did not reproduce it. Phase 2 attach tests should run the remote server with `-v`.

## Long-lived stream

`longstream.ts` spawns `openshell … exec --no-tty` from Bun detached with stdin ignored
(what a naive hub puller would do) and logs arrivals after idle gaps of
0/60/300/600/1200/1800/3600×4 s. Started 2026-10-11 11:14 UTC; the Mac may sleep in
between, which then doubles as the drop test.

_Result: pending._

## Phase 1 smoke test (2026-10-20)

Real gateway `ai-sandbox` (server 0.0.116, client 0.0.116; a 0.1.3 client cannot talk to it,
the workspace field is misparsed), workbench image `openshell-workbench:e797e53b7f50`,
binaries uploaded (no image change), stub agent `stub-agent-loop.sh` (one turn / 20 s), Mac
side an isolated hub from the branch under a temp HOME. Script: `phase1-smoke.sh`.

**Blocker found and fixed (R19/R20):** `exec --no-tty` does not start the remote command
until the local stdin reaches EOF (`(sleep 6) | openshell … exec -- sh -c 'echo hi'` prints
at +6 s; a never-closed pipe never starts it). Design change 1 above is wrong for 0.0.116:
the follower now spawns with stdin closed; the remote side is then orphaned when the Mac
process dies (re-verified: a follower survived its killed exec for 140 s+), so the remote
follower is bounded by the consumer lock (replaced on reconnect) and
`--max-duration 3600` (exit 75 = planned rotation; 75 survives the transport).

| Check | Result |
|---|---|
| Discovery (`--selector agmux=1`), `AGMUX_HOST` via create `--env` | ✓ |
| First sync after Mac hub start | ≈2 s; `ls --remote` shows `⇄ agmux-smoke`, pid/tmux masked; `ls --local` excludes it |
| Live updates | turn counts equal on both sides within seconds |
| `kill` / `attach` on the remote row | refused, exit 2; `attach --placement` → "no tmux pane", exit 1 (known minor) |
| Status-line chip | `⇄ ` prefix |
| Stream killed (Mac side) | reconnect, catch-up from cursor, 262 = 262 events, no duplicates; old remote follower replaced |
| Mac hub stopped / restarted | remote follower orphaned, then replaced by the new hub's follower (exactly one) |
| Idle stream (keepalives only) | 16 min, no reconnect on either side |
| Sandbox without `AGMUX_HOST` | `hub status`: stale + "create the sandbox with --env AGMUX_HOST=ai-sandbox/agmux-nohost"; follower backs off to the cap |
| Sandbox deleted | session `lost` / rule `host-removed` after 8 s (2 listings) |
| Same name recreated | old session `lost` / `host-reset` (db 3a867427 → 41e2e208), new session live |
| Discovery error (bad gateway env) | shown in `hub status` (`remote … error: Unknown gateway …`) |

**Not covered:** Mac sleep / network loss (only simulated by killing the stream), a gateway or
VM restart, idle gaps beyond 16 min, real Claude hooks (needs a logged-in sandbox from the
launcher), arm64. Minor UX finding: for an idle but healthy sandbox `hub status` says
"last sync 16m ago" — the timestamp only moves with the cursor.

## Phase 2 smoke test (2026-10-21)

Remote attach against a real sandbox. Observed on: Mac openshell 0.1.5, gateway `ai-sandbox`
0.1.5 (docker driver), Mac tmux 3.6a, sandbox tmux 3.7c, image `openshell-workbench:1057569940bb`
with its own agmux 0.1.0-alpha.2 (Phase 1 build, nothing uploaded but the stub). Scratch
sandbox `agmux-p2-smoke` (label `agmux=1`, `AGMUX_HOST` via `--env`), stub agent
`stub-agent-loop.sh` (one turn / 10 s) in the sandbox's tmux session `work`. Mac side isolated:
hub from the branch under a temp HOME, `[[remote]]` with default `agmux_bin`, its own tmux
server (`-S`, `-f /dev/null`) with a control-mode client as the terminal. The openshell
wrapper logs every call, so the reap exec is visible. Script: `phase1-smoke.sh phase2`
(self-contained, always deletes the sandbox). 4 runs, the last one 0 failures.

| Check | Result |
|---|---|
| 1. Replication | `ls --remote` after ≈2 s; `inspect` `.session.remote_tmux` = `work`/`@0`/`%0`/`/tmp/tmux-998/default`, `remote_pid` set, `pid` null ✓ |
| 2. `attach --placement new-window --mode view` | stub output in the local pane 0.7 s after the command; pane options `@agmux_remote=1`, `@agmux_attach_mode=view`; window `⇄ <id8>`; sandbox has `agmux-view-<id8>-p<N>` (1 window, 1 client); no status bar ✓ |
| 2. `M-d` | window closed after ≈250 ms, no hold; no `agmux-view-*` left ✓ |
| 3. `kill-window` (hangup reap) | reap exec (`--no-tty … sh -c <script> agmux p<N>`) started +18 ms after the kill; view gone at the first poll, ≈120–150 ms ✓ |
| 3b. Control: pane process SIGKILLed first, then `kill-window` (no reap) | view gone at the first poll too (≈140–160 ms); same with the openshell client SIGKILLed. See below ✓ |
| 4. `--mode full` | inner status bar `[work] 0:bash* …` visible, sandbox prefix `C-a`; state `full <sock> <pid>`, `ps -o comm=` = `tmux: client` (Linux proctitle; matches `tmux*`); `C-a d` → pane exit status 0 after ≈280 ms; `kill-window` → reap exec ran, client gone ≈150 ms ✓ |
| 5. Stopped sandbox | stays in `sandbox list` as `Stopped` (stop ≈0.4–0.5 s). Attach: `get` +0.45 s, `start` +0.5 s, script exec +1.2–2.2 s (start took 0.7–1.7 s). The sandbox starts, but the agent died with the container: the script exits 3 ("the session's tmux window @0 is gone"), the hold shows it, the reap runs. After restarting the stub, attaching the new session works (output after 0.7 s) ✓ (with the caveat below) |
| Lost row | `attach` refused, exit 2, message with the by-hand `sandbox exec … --tty -- agmux attach <id>` ✓ |

Latencies (warm, Ready sandbox): `agmux attach` CLI returns in ≈0.4 s; agent output visible
≈0.7 s; a `--no-tty` exec round trip ≈120–150 ms.

**openshell tears down the remote side of a `--tty` exec (observed on 0.1.5).** When the local
openshell client dies (SIGHUP from the closed pane, or SIGKILL), the remote pty is hung up and
the sandbox tmux client exits; `destroy-unattached` then removes the view. So on 0.1.5 the
hangup reap is redundant for these paths: it still runs (+18 ms) and both race to the same end
state. It stays needed for what was not tested: Mac sleep / network loss without a clean
disconnect, other openshell versions (0.0.116 orphaned `--no-tty` remotes, Phase 1), and the
next-attach reap for a crashed Mac.

**Stale coords after a sandbox restart (design gap, not a code defect).** `sandbox stop` kills
every process; the row stays live until the sandbox hub's liveness sweep (every 30 s, and only
once something runs agmux there again; the Mac follower does). A new tmux server reuses the
same socket path and window ids (`@0`), so the window check passes for the dead row.
Reproduced: stop, start, start a new stub in `work`, attach the OLD row within 4 s → exit 0, the
pane shows the NEW agent. The window lasts until the sweep marks the old row `lost` (≈30–60 s
seen); pid reuse after a restart (pids restart low; the old stub's pid 193 was reused by a
`head` once) can stretch it. A fix would need a server identity in the coords (e.g. the tmux
server pid or `#{start_time}`) checked by the script.

Other: two sessions started within ≈65 s share the first 8 id chars (UUIDv7), so the view name
`agmux-view-<id8>-<tag>` is not unique per session; the tag keeps it unique per local pane.
A Stopped sandbox showed `stale` ("not ready (phase: Stopped)") in `hub status` once and still
`ok` 12 s after the stop in the scripted runs (timing of the follower's next reconnect).

**Not covered (by hand, spec §11, in Ghostty with real Claude):** Shift+Enter newline, Esc
interrupt latency, mouse wheel into the inner copy-mode, OSC 52 yank; a real terminal client
(only a control-mode client here), Mac sleep / network loss, dash / status-line attach paths.

## Open

- Real Claude through the hooks: `wi-sag-280` claude is not logged in (provider attached or
  not is unclear from sandbox metadata). Needs a logged-in agent (a fresh
  `sag-sandbox-create` sandbox has `claude-chax`).
- arm64 on the Mac gateway (binary, hub, `bun:sqlite`).
- Manual N1 check in Ghostty with real Claude: Shift+Enter newline, Esc interrupt latency,
  mouse wheel → inner copy-mode, OSC 52 yank. Script: `n1-manual.sh`.

## Files

- `stub-agent.sh` — fires the claude plugin hook points like Claude would, then prints
  every input byte as hex (`STUB_EXTKEYS=1` requests modifyOtherKeys 2 first).
- `view.sh` — N1 view, link-window variant, with fixes 2 and 3.
- `longstream.ts` — long-lived `exec` stream logger.
- `n1-manual.sh` — manual N1 check in a real terminal.
- `stub-agent-loop.sh` — stub agent that runs one turn every `STUB_INTERVAL` s (phase 1 smoke).
- `phase1-smoke.sh` — phase 1 smoke test: `setup` / `check` / `teardown`; phase 2 (remote attach): `phase2`.

## Left in place (clean up when done)

In `wi-sag-280`: `/sandbox/.spike/` (binaries, scripts), `~/.agmux/` (hub running), the
agmux plugin in `~/.claude/skills/agmux/` (backup of `~/.claude` in
`~/.spike/claude-backup`), isolated tmux server `-L spike`. On the Mac: tmux server
`-L agmux-spike`.
