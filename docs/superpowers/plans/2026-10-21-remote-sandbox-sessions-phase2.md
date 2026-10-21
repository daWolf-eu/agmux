# Remote Sandbox Sessions — Phase 2 (attach) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** You can open a live session in an OpenShell sandbox from the Mac: from `agmux attach`, dash ⏎ / `A`, or a status-line click. It opens either as a transparent view (N1, the default inside tmux) or as a full remote tmux client (N2). Closing the local window leaves no orphaned client behind, and focusing a remote window marks the session seen. Remote tmux coordinates and the pid are exposed on remote rows, for attach and for scripting.

**Architecture:**
- Replicated rows already carry the sandbox's `tmux_*` and `pid` (stored verbatim; Phase 1 masks them at read time).
- Phase 2 keeps the local fields null and exposes the values as `remote_tmux` / `remote_pid`, so local consumers (focus-seen, notifyd, dash mirror, `kill`) stay safe.
- A local pane runs `agmux attach <id> --remote-client`. It:
  - validates the coords;
  - tags its own tmux pane;
  - runs `openshell … sandbox exec --tty -- sh -c <FIXED SCRIPT> agmux <validated args…>` in the foreground.
- The scripts are constants. Values go in only as positional parameters, so nothing from a row is ever spliced into script text.
- The view script builds the spec §8.1 view session; the full script attaches a normal client. Both record the client in `$HOME/.agmux/attach/<tag>`.
- On SIGHUP or SIGTERM of the local pane, or a failed transport, the Mac runs the fixed reap script through `exec --no-tty`. A new attach with the same tag reaps first.
- The sandbox needs only `sh` and `tmux`. No agmux change runs inside it, so homelab needs no restage.

**Tech Stack:** Bun ≥ 1.3, TypeScript, `bun:test`, `smol-toml`, OpenTUI (dash), POSIX `sh`, tmux ≥ 3.2 (sandbox: 3.7c).

**Spec:** [`docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md`](../specs/2026-10-08-remote-sandbox-sessions-design.md) §4.5, §4.7, §8, §9, §10 Phase 2. Related: [`2026-10-09-dash-attach-popup-design.md`](../specs/2026-10-09-dash-attach-popup-design.md) (its remote column, `m`); Phase 1 implementation notes (spec §10); spike `docs/spikes/2026-10-11-remote-sandbox/view.sh`.

## Global Constraints

- Foundation §14 holds. Phase 2 adds no event kind and no schema version.
- On remote rows, `pid` / `tmux_*` stay null. The remote values live only in `remote_pid` / `remote_tmux`. Remote `kill` and remote resume stay refused (Phase 3).
- Nothing from a replicated row reaches a shell as code. Scripts are string constants; values are positional args after the `$0` name `agmux`. Values are validated before use (`isRemoteTmux`, Task 1):
  - `session_id`: canonical UUID (`isShellSafeId`).
  - tag: `^[A-Za-z0-9_-]{1,32}$`.
  - detach key: `^[A-Za-z0-9-]{1,16}$`.
  - window: `^@\d{1,9}$`; pane: `^%\d{1,9}$` or null.
  - socket: null or `^/[A-Za-z0-9._/-]{1,255}$`.
  - tmux session name: 1–128 chars, no control chars, no `:` or `.`.
- Text put into a tmux format (window names) passes `stripControls` and has every `#` doubled.
- Verified 2026-10-21 on openshell 0.1.5 / ai-sag: `sandbox exec -- sh -c '…' x 'a b' '$HOME' ';' '"q"' "it's" ''` arrives verbatim (`[a b][$HOME][;]["q"][it's][]`); the sandbox's tmux is 3.7c; the replicated coords are `work|@0|%0|/tmp/tmux-998/default`.
- Every `exec --no-tty` runs with stdin closed (Phase 1 R19). `--tty` execs inherit the terminal.
- View session `agmux-view-<id8>-<tag>`, key table `agmux-view`, detach key default `M-d`, client `tmux -u`. `destroy-unattached on` is set only on the attach command line. Never group sessions (tmux 3.6a segfault, spec §8.1).
- OpenShell: no version pins. Write version-specific behaviour as "observed on <version>".
- Keep `bun run typecheck` and `bun test` green, add a `CHANGELOG.md` Unreleased entry, and document new mechanisms in the package `AGENTS.md`.

## Decisions this plan makes (spec gaps / inconsistencies)

1. **`[attach.remote]`, not `[remote.attach]`.** `remote` is already an array of tables (`[[remote]]`), so `[remote.attach]` would become a subtable of the last `[[remote]]` entry. Keys and defaults: `placement = "new-window"`, `mode = "view"`, `window_name = "⇄ {title}"`, `detach_key = "M-d"`. The spec's `[attach] view_detach_key` becomes `detach_key` here.
2. **Remote coords are exposed, namespaced.** `SessionRow.remote_tmux: { session, window, pane, socket } | null` and `remote_pid: number | null`, set only on remote rows. Shown in `inspect` (JSON) and in `ls`'s TMUX column. PID stays `-` for remote rows: a pid you cannot signal from here.
3. **The Mac builds the attach from the replicated coords; the sandbox needs only sh + tmux.** This replaces the spec's `agmux attach --view|--full|--reap` running remotely (§8.1) with three fixed sh scripts (Task 3). Stale coords are caught inside the script (`display-message -t <window>` fails → exit 3, with a message).
4. **The local pane process tags itself.** `agmux attach <id> --remote-client --mode <m> --detach-key <k>` reads `$TMUX_PANE`:
   - `%12` gives tag `p12`;
   - outside tmux, the tag is `t` + 8 random hex chars.
   It sets its own pane options `@agmux_session_id`, `@agmux_remote=1` and `@agmux_attach_mode`, so every placement gets the bookkeeping.
5. **Reap state** is one line in `$HOME/.agmux/attach/<tag>`: `view <socket|-> <view-name>` or `full <socket|-> <pid>`.
   - Full mode records `$$` and then `exec`s tmux, so the pid is the client's.
   - Reap kills the view session, or kills the pid only if `ps -o comm=` starts with `tmux`.
   - The file is left behind after a normal exit and cleared by the next reap of that tag.
6. **Mode default:** `[attach.remote] mode` inside tmux, `full` outside it (N4, spec §8.1). An explicit `--mode` or `m` wins.
7. **Not built:** peek (slot 5 stays dimmed, "planned") and N3.
8. **Closed remote session:** resume is refused. The message includes the command to run by hand (spec §4.7): `<openshell> -g <gw> sandbox exec -n <sbx> --tty -- <agmux_bin> attach <id>`.
9. **Stopped sandbox:** the pane process runs `sandbox get <sbx> -o json` first, and if `phase === "Stopped"` runs `sandbox start <sbx>`. A failing `get` is ignored; the exec then reports the real error.
10. **`session.seen` for a remote row** is stamped with the local host (`resolveHost()`), not `row.host` (spec §4.5).
11. **`{title}`** is the session `name`, or the first 8 chars of the id. It gets `stripControls`, `#` doubled, and is capped at 40 display columns.

## Review Focus

1. **Local window closed mid-view.** An orphaned remote client keeps the view attached and pins the agent window's size. Expected: SIGHUP reaps, and the view session is gone within seconds. → Task 4 test `SIGHUP runs reap with stdin closed`; Task 8 test `closing the local window reaps the view`.
2. **Coords stale or agent gone** (window killed since the last sync, sandbox recreated). Expected: the local pane stays open with `the session's tmux window @N is gone`, and no stray view session is left. → Task 3 test `missing window exits 3 and leaves no view`.
3. **Agent exits while viewed.** Expected: the view is destroyed, the transport exits 0, the local pane closes with no hold, and the remote tmux server survives. → Task 3 test `agent window killed → view session gone, server alive`.
4. **Hostile or odd values from a sandbox:**
   - Session names like `#(cmd)`, with control chars, or 200 chars long, in window names. Expected: shown literally, no format expansion, capped. → Task 5 test `window name escapes formats and caps width`.
   - Coords with shell or tmux metacharacters (`work;kill-server`, `@1 -t x`). Expected: refused before any exec. → Task 1 test `isRemoteTmux rejects metacharacters`; Task 3 test `positional args are never interpreted`.
5. **Attaching again to the same session.** Expected: switch to the existing window for the same mode, while a different mode opens a second window. Leftovers from a Mac crash with the same tag are reaped first. → Task 5 test `dedup per mode`; Task 3 test `same tag reaps the previous client first`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/protocol/src/attach.ts` | `REMOTE_ATTACH_MODES`, `RemoteAttachMode`, `isAttachTag`, `isTmuxKeyName`, `RemoteTmux`, `isRemoteTmux` |
| `packages/protocol/src/session.ts`, `packages/store/src/queries.ts` | `remote_tmux` / `remote_pid` on remote rows |
| `packages/wrapper/src/profile.ts`, `packages/cli/src/attach-place.ts` | `[attach.remote]` config → `AttachSettings.remote` |
| `packages/tui/src/shared/attach-targets.ts`, `packages/tui/src/types.ts` | `remote` attach kind, targets, defaults, `AttachRequest.mode` |
| `packages/cli/src/remote-tmux.ts` (new) | the three fixed sh scripts + argv builders |
| `packages/hub/src/sync/transport.ts` | `transportArgv`, `transportControlArgv` |
| `packages/cli/src/remote-client.ts` (new) | Mac pane process: tag, pane options, ensure-started, transport, reap |
| `packages/cli/src/attach-remote.ts` (new) | Mac placement: dedup, window name, placements, manual-resume text |
| `packages/cli/src/attach.ts`, `attach-placed.ts`, `dash-actions.ts`, `remote-guard.ts`, `bin/agmux.ts`, `ls.ts`, `inspect.ts` | route remote rows; flags; show coords |
| `packages/tui/src/opentui/DashApp.tsx`, `Overlays.tsx` | mode line and `m` in the attach popup |
| `packages/cli/src/seen.ts` | pane-option lookup for focus-seen; local host for remote seen |
| `tests/e2e/fake-openshell.sh`, `tests/e2e/remote-attach.test.ts` (new) | `--tty` exec, `get`/`start`, call log; the full chain on two real tmux servers |

---

### Task 1: Protocol values, `[attach.remote]` config, remote attach targets

**Files:**
- Modify: `packages/protocol/src/attach.ts`, `packages/wrapper/src/profile.ts` (`AttachConfig`, `parseAttachSection`), `packages/cli/src/attach-place.ts` (`AttachSettings`), `packages/tui/src/shared/attach-targets.ts`, `packages/tui/src/types.ts` (`AttachRequest`)
- Test: `packages/protocol/tests/attach.test.ts`, the existing `parseAttachSection` test file in `packages/wrapper/tests`, `packages/cli/tests/attach-place.test.ts`, `packages/tui/tests/attach-targets.test.ts`

**Interfaces:**
- Produces:
  - `REMOTE_ATTACH_MODES = ["view", "full"] as const`, `type RemoteAttachMode`, `isRemoteAttachMode(v: unknown): v is RemoteAttachMode`.
  - `isAttachTag(s: string): boolean` and `isTmuxKeyName(s: string): boolean`, with the regexes from Global Constraints.
  - `interface RemoteTmux { session: string; window: string; pane: string | null; socket: string | null }` and `isRemoteTmux(v: unknown): v is RemoteTmux`, using the Global Constraints rules.
  - `AttachConfig.remote: { placement?: AttachPlacement; mode?: RemoteAttachMode; windowName?: string; detachKey?: string }`.
  - `AttachSettings.remote: { placement: AttachPlacement; mode: RemoteAttachMode; windowName: string; detachKey: string }`, which `attachSettingsFrom` fills with the Decision 1 defaults.
  - `AttachKind = "live" | "closed" | "remote" | "none"`: `"remote"` for a remote row with a live status, `"none"` for a closed remote row.
  - `AttachDefaults.remote?: AttachPlacement` and `AttachRequest { placement: AttachPlacement; mode?: RemoteAttachMode }`.

- [ ] **Step 1: Write failing tests**
  - `isAttachTag`: accepts `"p12"` and `"t0a1b2c3d"`; rejects `""`, `"a;b"` and `"x".repeat(33)`.
  - `isTmuxKeyName`: accepts `"M-d"` and `"F12"`; rejects `"M-d;kill-server"`.
  - `isRemoteTmux` accepts `{ session: "work", window: "@0", pane: "%0", socket: "/tmp/tmux-998/default" }` and the same with `pane: null, socket: null`.
  - `isRemoteTmux rejects metacharacters`:
    - session `"work:1"`, `"a.b"`, `"x\u0007"` and 129 chars;
    - window `"@1 -t x"` and `"1"`;
    - pane `"%1;"`;
    - socket `"tmp/x"` and `"/tmp/a b"`.
  - `parseAttachSection({ remote: { placement: "new-pane", mode: "full", window_name: "R {title}", detach_key: "C-q" } }, undefined).remote` equals `{ placement: "new-pane", mode: "full", windowName: "R {title}", detachKey: "C-q" }`.
  - These throw a message naming `[attach.remote]`: an unknown key, `mode = "toggle"`, `detach_key = "M-d;x"`, `placement = "nowhere"`.
  - `attachSettingsFrom({ terminal: {} }, "agmux").remote` equals the Decision 1 defaults.
  - `attachKind` gives `remote` for a remote `running` row and `none` for a remote `ended` row.
  - `attachTargets("remote", inTmuxCtx)`:
    - enables inline, new-pane, new-window and new-session;
    - peek is disabled with reason `planned`;
    - new-tab / new-terminal follow `[terminal]`;
    - with `popup: true`, inline is disabled with reason `in popup`;
    - outside tmux, slots 2–4 have reason `not in tmux`.
  - `defaultPlacement("remote", ctx, {})` is `new-window` in tmux and `inline` outside it; with `{ remote: "new-pane" }` it is `new-pane`.
- [ ] **Step 2: Run** `bun test packages/protocol packages/wrapper packages/cli/tests/attach-place.test.ts packages/tui/tests/attach-targets.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `tableOf("[attach]", …)` allows `"remote"`.
  - The subtable gets its own `tableOf("[attach.remote]", …, ["placement", "mode", "window_name", "detach_key"])`.
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote): attach mode values, [attach.remote] config, remote attach targets`

### Task 2: Expose remote coords and pid

**Files:**
- Modify: `packages/protocol/src/session.ts` (`SessionRow`), `packages/store/src/queries.ts` (`decodeRow`), `packages/cli/src/ls.ts` or the TUI column formatter that renders TMUX, `packages/cli/src/inspect.ts` (only if it rebuilds the row)
- Test: `packages/store/tests/` (the Phase 1 masking test file: `remote rows expose no pid or tmux coords`), the ls formatting test

**Interfaces:**
- Consumes: `RemoteTmux`, `isRemoteTmux` (Task 1).
- Produces: `SessionRow.remote_tmux?: RemoteTmux | null` and `SessionRow.remote_pid?: number | null`.
  - Both are non-null only on remote rows. `remote_tmux` is null unless the stored `tmux_session` and `tmux_window` are both set.
  - Values pass `stripControls`. They are not validated here: validation happens at the point of use (Task 4), so `inspect` still shows what the sandbox sent.

- [ ] **Step 1: Write failing tests**
  - A replicated row with `work|@0|%0|/tmp/tmux-998/default|446` reads back with `tmux_* = null`, `pid = null`, `remote_tmux = { session: "work", window: "@0", pane: "%0", socket: "/tmp/tmux-998/default" }` and `remote_pid = 446`.
  - A local row has `remote_tmux = null` and `remote_pid = null`.
  - A remote row without a `tmux_window` has `remote_tmux = null`.
  - `ls` renders TMUX `work:@0` for that remote row and PID `-`.
- [ ] **Step 2: Run** `bun test packages/store packages/cli/tests/ls*.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `decodeRow`. For the TMUX column, a remote row uses `remote_tmux`; nothing else reads it.
- [ ] **Step 4: Run** `bun test packages/store packages/cli packages/tui` and `bun run typecheck`. Expected: PASS; the Phase 1 "pid/tmux masked" assertions still hold.
- [ ] **Step 5: Commit** `feat(remote): expose remote tmux coords and pid on remote rows`

### Task 3: The fixed remote scripts

**Files:**
- Create: `packages/cli/src/remote-tmux.ts`
- Test: `packages/cli/tests/remote-tmux.test.ts` (argv shape), `tests/remote-tmux-scripts.test.ts`. The second runs the scripts locally with `sh` against a real tmux server (`-S <tmpdir>/inner.sock`, `-f /dev/null`, `HOME=<tmpdir>`), and is skipped when `tmux` is missing.

**Interfaces:**
- Consumes: `RemoteTmux`, `RemoteAttachMode` (Task 1).
- Produces:
  - `viewSessionName(sessionId: string, tag: string): string`, giving `agmux-view-<id8>-<tag>`.
  - `viewScriptArgv(c: RemoteTmux, view: string, key: string, tag: string): string[]`, giving `["sh", "-c", VIEW_SCRIPT, "agmux", c.socket ?? "", c.window, c.pane ?? "", view, key, tag]`.
  - `fullScriptArgv(c: RemoteTmux, tag: string): string[]`, giving `["sh", "-c", FULL_SCRIPT, "agmux", c.socket ?? "", c.session, c.window, c.pane ?? "", tag]`.
  - `reapScriptArgv(tag: string): string[]`, giving `["sh", "-c", REAP_SCRIPT, "agmux", tag]`.
  - Exit codes: 0 means the client ended normally; 3 means the target is gone or setup failed (a message goes to stderr). Anything else comes from tmux.

The scripts are the algorithm, so their text is pinned here. `REAP_FN` is shared by all three:

```sh
# REAP_FN
st=$HOME/.agmux/attach
t() { if [ -n "$sock" ]; then tmux -S "$sock" "$@"; else tmux "$@"; fi; }
reap() {
  f=$st/$1; [ -f "$f" ] || return 0
  read -r m s x < "$f"; rm -f "$f"
  [ "$s" = - ] && s=
  case $m in
    view) if [ -n "$s" ]; then tmux -S "$s" kill-session -t "=$x"; else tmux kill-session -t "=$x"; fi 2>/dev/null ;;
    full) case $(ps -o comm= -p "$x" 2>/dev/null) in tmux*) kill "$x" ;; esac ;;
  esac
  return 0
}
```

```sh
# VIEW_SCRIPT  ($1 socket, $2 window, $3 pane, $4 view, $5 key, $6 tag) — spec §8.1 order
sock=$1 win=$2 pane=$3 view=$4 key=$5 tag=$6
<REAP_FN>
mkdir -p "$st" && reap "$tag"
t display-message -p -t "$win" '#{window_id}' >/dev/null 2>&1 \
  || { echo "agmux: the session's tmux window $win is gone" >&2; exit 3; }
{ t new-session -d -s "$view" \
  && t set -t "$view" status off \; set -t "$view" prefix None \; set -t "$view" prefix2 None \
       \; set -t "$view" key-table agmux-view \; set -t "$view" mouse on \
  && t bind -T agmux-view "$key" detach-client \
  && t link-window -s "$win" -t "$view:" \
  && t kill-window -t "$view:^"; } \
  || { t kill-session -t "=$view" 2>/dev/null; echo "agmux: could not build the view" >&2; exit 3; }
[ -n "$pane" ] && t select-pane -t "$pane"
printf 'view %s %s\n' "${sock:--}" "$view" > "$st/$tag"
# destroy-unattached only here: set earlier it fires on kill-window (3.7c). -u: exec --tty sets no UTF-8 locale.
if [ -n "$sock" ]; then exec tmux -u -S "$sock" attach-session -t "=$view" \; set -t "$view" destroy-unattached on
else exec tmux -u attach-session -t "=$view" \; set -t "$view" destroy-unattached on; fi
```

`FULL_SCRIPT` (`$1` socket, `$2` session, `$3` window, `$4` pane, `$5` tag) runs, in order:
1. `REAP_FN`, then `mkdir -p` and `reap`.
2. The same window check, with exit 3.
3. `printf 'full %s %s\n' "${sock:--}" "$$" > "$st/$tag"`.
4. `exec tmux -u [-S "$sock"] attach-session -t "=$2" \; select-window -t "$3"`, plus `\; select-pane -t "$4"` when `$4` is set. Build that tail with `set --` so no `eval` is needed.

`REAP_SCRIPT` (`$1` tag) is `sock=`, then `REAP_FN`, then `reap "$1"`.

- [ ] **Step 1: Write failing tests.**
  - Argv-shape unit tests: `viewScriptArgv` puts an empty string for a null pane and null socket, `$0` is `agmux`, and the script texts are exported constants.
  - Real-tmux tests. Start the inner server with `new-session -d -s work 'sleep 600'`, then run the scripts' setup through `sh` with the final `exec tmux … attach-session` intercepted. Put a stub `tmux` on PATH that passes everything to the real binary except `attach-session`, which it logs and exits 0 on.
    - `view setup links the agent window`: the session `agmux-view-<id8>-p1` holds `work`'s window id; `show -t V -v key-table` is `agmux-view`; `prefix` is `None`; `list-keys -T agmux-view` binds `M-d` to `detach-client`; the state file is `view <sock> <V>`.
    - `missing window exits 3 and leaves no view`: window `@99` exits 3, stderr contains `@99 is gone`, and `list-sessions` shows no `agmux-view-*`.
    - `agent window killed → view session gone, server alive`: kill `work`'s window; `has-session -t =V` fails, and the server still answers.
    - `same tag reaps the previous client first`: run the view setup twice with tag `p1` and different view names; only the second view exists.
    - `reap kills the view and clears the state`: `reapScriptArgv("p1")` removes the view session and the state file.
    - `full mode records the client pid`: the state file is `full <sock> <pid>`, where pid is the shell's `$$`.
    - The stub-logged attach argv ends with `select-pane -t %0`.
    - `positional args are never interpreted`, checked statically on the three constants:
      - there is no `eval`;
      - `$1`…`$6` appear only on the first assignment line (`sock=$1 win=$2 …`, or `reap "$1"` in `REAP_SCRIPT`);
      - every later use of a variable is double-quoted.
      Check it dynamically too: run `REAP_SCRIPT` with tag `p1` while a file named `$(touch pwned)` sits in the state dir. No `pwned` file is created.
- [ ] **Step 2: Run** `bun test packages/cli/tests/remote-tmux.test.ts tests/remote-tmux-scripts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `remote-tmux.ts`: the three constants (assembled from `REAP_FN` + body) and the builders.
- [ ] **Step 4: Run** the same tests. Expected: PASS under both `/bin/sh` on macOS and `dash`; CI runs Ubuntu, where `sh` is dash.
- [ ] **Step 5: Commit** `feat(remote): fixed sh scripts for remote view, full attach and reap`

### Task 4: Mac pane process — `agmux attach <id> --remote-client`

**Files:**
- Modify: `packages/hub/src/sync/transport.ts`
- Create: `packages/cli/src/remote-client.ts`
- Modify: `packages/cli/bin/agmux.ts` (`attach` parses `--remote-client`, `--mode` and `--detach-key`)
- Test: `packages/hub/tests/sync-transport.test.ts`, `packages/cli/tests/remote-client.test.ts`

**Interfaces:**
- Consumes: `TransportSpec`, `HostRow` (protocol); `runCapture` (hub); Tasks 1–3.
- Produces:
  - `transportArgv(spec: TransportSpec, cmd: string[], o: { tty: boolean }): string[]`. `openshellTransport(r).argv` delegates to it.
  - `transportControlArgv(spec: TransportSpec, verb: "get" | "start"): string[]`, giving `[bin, "-g", gw, "sandbox", "get", target, "-o", "json"]` or `[bin, "-g", gw, "sandbox", "start", target]`.
  - `tagFor(env: Record<string, string | undefined>, rand: () => string): string` (Decision 4).
  - `runRemoteClient(o: { sessionId: string; mode: RemoteAttachMode; detachKey: string; hubUrl: string; env: Record<string, string | undefined> }, deps?: RemoteClientDeps): Promise<number>`.
  - `RemoteClientDeps { fetchImpl; tmux(args: string[]): Promise<void>; capture(argv: string[], timeoutMs: number): Promise<string>; spawnTty(argv: string[]): { exited: Promise<number> }; onSignal(sig: "SIGHUP" | "SIGTERM", fn: () => void): void; exit(code: number): never; rand(): string }`.
    - `capture` defaults to `runCapture`, which closes stdin and has a timeout.
    - `spawnTty` inherits stdio.

- [ ] **Step 1: Write failing tests**
  - `transportArgv` for `--tty` / `--no-tty` matches the Phase 1 argv shape; `transportControlArgv` matches as specified.
  - `tagFor`: `{ TMUX_PANE: "%12" }` gives `p12`, `{}` gives `t` + rand, and a non-`%N` value falls back to the random tag.
  - `runRemoteClient` against a fake hub: `/sessions/<id>` returns a remote live row with `remote_tmux`, and `/hosts` returns its transport.
    - View mode in `%12` sets `@agmux_session_id`, `@agmux_remote 1` and `@agmux_attach_mode view` via `set-option -p -t %12`.
    - It spawns exactly `transportArgv(spec, viewScriptArgv(coords, viewSessionName(id, "p12"), "M-d", "p12"), { tty: true })`.
    - It returns 0 and makes no reap call.
  - Full mode spawns `fullScriptArgv`.
  - `non-zero transport exit is returned and reaps`: when the child exits 3, `capture` receives `transportArgv(spec, reapScriptArgv("p12"), { tty: false })` and the result is 3.
  - `SIGHUP runs reap with stdin closed`: the SIGHUP handler calls `capture(reap argv)` and then `exit(129)`; SIGTERM gives `exit(143)`.
  - Stopped sandbox: when `capture(get)` returns `{"phase":"Stopped"}`, `capture(start)` runs before the spawn. When `get` throws, the spawn still happens.
  - Refusals (exit 1, one line each, nothing spawned): the row is not remote; it is not live; `remote_tmux` fails `isRemoteTmux` (`unsupported tmux coordinates from <host>`); there is no `hosts` row or `transport: null` (`<host> has not synced yet`).
- [ ] **Step 2: Run** `bun test packages/hub/tests/sync-transport.test.ts packages/cli/tests/remote-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Mode and key come from flags; the placer (Task 5) decides them.
- [ ] **Step 4: Run** the tests and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote): local pane process runs the remote script and reaps on hangup`

### Task 5: Mac placement, dedup and the attach entry points

**Files:**
- Create: `packages/cli/src/attach-remote.ts`
- Modify:
  - `packages/cli/src/attach.ts`: in `attachCmd`, a remote row uses the `[attach.remote]` defaults; add `AttachOpts.settings?: AttachSettings`.
  - `packages/cli/src/attach-placed.ts`: `--mode`.
  - `packages/cli/src/dash-actions.ts`: `attach` / `resume` for remote rows.
  - `packages/cli/src/remote-guard.ts`: the resume message.
  - `packages/cli/bin/agmux.ts`: pass `settings` to `attachCmd` in the `attach` and `statusline --click` paths; parse `--mode`.
- Test: `packages/cli/tests/attach-remote.test.ts`, plus the existing `dash-actions`, `attach-placed` and `remote-guard` tests

**Interfaces:**
- Consumes: Tasks 1–4; `splitPane`, `newWindow`, `newSession`, `switchClient`, `readCurrentPane` (`tmux-place.ts`); `expandTemplate`, `resumeSessionName`, `shellQuote` (`attach-place.ts`); `transportArgv`; `[[remote]].agmux_bin` via `loadRemotes` (a broken config or missing entry falls back to `"agmux"`).
- Produces:
  - `remoteWindowName(tpl: string, row: SessionRow): string` (Decision 11).
  - `findRemotePane(sessionId: string, mode: RemoteAttachMode, listPanes: () => Promise<string>): Promise<{ session: string; window: string; pane: string } | null>`. It parses `list-panes -a -F '#{session_name}\t#{window_id}\t#{pane_id}\t#{@agmux_session_id}\t#{@agmux_attach_mode}'`.
  - `remotePaneCmd(agmuxBin: string, sessionId: string, mode: RemoteAttachMode, detachKey: string): string[]`, giving `[agmuxBin, "attach", id, "--remote-client", "--mode", mode, "--detach-key", key]`. Here `agmuxBin` is the Mac's agmux.
  - `attachRemote(row: SessionRow, req: AttachRequest | undefined, env: { ctx: AttachCtx; settings: AttachSettings }, deps: AttachRemoteDeps): Promise<Handoff | null>`:
    - placement: `resolvePlacement("remote", ctx, req?.placement, { remote: settings.remote.placement })`;
    - mode: `req?.mode ?? (ctx.inTmux ? settings.remote.mode : "full")`;
    - in tmux, dedup runs first: `switch-client` to the window found, then `select-pane`;
    - `inline` → `{ argv: remotePaneCmd(…) }`;
    - `new-pane` / `new-window` / `new-session` go through the tmux-place helpers. Name the window `remoteWindowName(…)`, then run `set-option -w -t <window> automatic-rename off`; for `new-session`, also `switchClient`;
    - `new-tab` / `new-terminal` → a template over `[agmuxBin, "attach", id, "--placement", "inline", "--mode", mode]`.
  - `manualResumeCommand(spec: TransportSpec, sandboxAgmuxBin: string, sessionId: string): string`, which is `shellQuote`-joined `transportArgv(spec, [sandboxAgmuxBin, "attach", id], { tty: true })`. `remoteRefusal(row, "resume", manual?)` appends `; run it by hand: <manual>` to its message.

- [ ] **Step 1: Write failing tests**
  - `window name escapes formats and caps width`:
    - `#(rm -rf ~)` gives `⇄ ##(rm -rf ~)`;
    - `"a\u001b[31mb"` gives `⇄ ab`;
    - 200 × `x` is capped at 40 display columns plus the prefix;
    - with no name, the result is `⇄ <id8>`.
  - `dedup per mode`: a listing line `mac\t@4\t%9\t<id>\tview` leads to `switch-client -t mac:@4` and `select-pane -t %9` for mode `view`, with nothing placed. For `full`, `newWindow` is called instead.
  - Resolution:
    - in tmux with no req → `new-window` with `--mode view`;
    - outside tmux with no req → an `inline` handoff with `--mode full`;
    - `req.mode: "full"` → `--mode full`;
    - `peek` throws `peek: planned`.
  - `new-window` → `set-option -w -t @9 automatic-rename off`.
  - `dash-actions`:
    - `attach(remoteRow)` resolves;
    - `resume(closedRemoteRow)` throws a message containing `sandbox exec -n box1 --tty -- agmux attach <uuid>`;
    - `kill(remoteRow)` signals nothing.
  - `attachCmd` on a remote row with `TMUX` unset spawns `remotePaneCmd(…, "full", …)` in the foreground.
- [ ] **Step 2: Run** `bun test packages/cli`. Expected: the new tests FAIL, and so do Phase 1's attach-refusal tests. Update those: `kill` and `resume` stay refused, `attach` no longer is.
- [ ] **Step 3: Implement.** The status-line click goes through `attachCmd`, so it inherits this path.
- [ ] **Step 4: Run** `bun test packages/cli` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote): attach places remote sessions (view or full) from cli, dash and status line`

### Task 6: Dash — the mode in the attach popup

**Files:**
- Modify: `packages/tui/src/opentui/DashApp.tsx`, `packages/tui/src/opentui/Overlays.tsx` (`AttachOverlay`), the help overlay and footer hint, `packages/cli/src/dash.ts` (pass `remoteMode`)
- Test: the existing DashApp test file in `packages/tui/tests`

**Interfaces:**
- Consumes: `AttachKind` `"remote"`, `attachTargets` and `AttachRequest.mode` (Task 1).
- Produces: `DashAppProps.remoteMode?: RemoteAttachMode`, default `"view"`. `dash.ts` passes `ctx.inTmux ? settings.remote.mode : "full"`.

- [ ] **Step 1: Write failing tests**
  - `A` on a remote row renders `mode: view ⇄ full (m)`, and `m` flips the highlighted mode.
  - With the popup open and `m` pressed once, `3` calls `actions.attach(row, { placement: "new-window", mode: "full" })`.
  - On a local row there is no mode line and `m` does nothing.
  - ⏎ on a remote live row calls `actions.attach(row, undefined)`.
- [ ] **Step 2: Run** `bun test packages/tui`. Expected: FAIL.
- [ ] **Step 3: Implement.** `attachMode` resets to `props.remoteMode` each time the popup opens. The help overlay adds `m  attach mode (remote)`.
- [ ] **Step 4: Run** `bun test packages/tui` and `bun run typecheck`. Expected: PASS, except the known `watch-app.test.tsx` "reconnecting" flake, which fails on old main too.
- [ ] **Step 5: Commit** `feat(remote): dash attach popup offers the view/full mode`

### Task 7: Focus-seen for remote panes

**Files:**
- Modify: `packages/cli/src/seen.ts` (`resolvePane`), and the `postSeen` callers in `attach.ts`, `attach-placed.ts`, `dash-actions.ts` (`markSeen`) and `attach-remote.ts`
- Test: `packages/cli/tests/seen.test.ts`

**Interfaces:**
- Produces:
  - `resolvePane(pane, hubUrl, fetchImpl, socket?, readPaneOption?: (pane: string, socket?: string) => Promise<string | null>)`. When the pane option `@agmux_session_id` holds a canonical UUID, it wins over the `tmux_pane` match. The default `readPaneOption` runs `tmux [-S socket] show-options -pqv -t <pane> @agmux_session_id` and returns null on any failure.
  - `seenHost(row: Pick<SessionRow, "remote" | "host">): string`, which is `row.remote ? resolveHost() : row.host`.

- [ ] **Step 1: Write failing tests**
  - When the pane option names an open remote `done` session, `seenCmd({ pane: "%5", source: "focus" })` posts `session.seen` for that id with `host = resolveHost()`.
  - When the option names a session that isn't open: no post, exit 0.
  - A non-UUID value is ignored, and the `tmux_pane` match still applies.
  - `markSeen(remoteRow)` posts with the local host.
- [ ] **Step 2: Run** `bun test packages/cli/tests/seen.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote): focusing a remote window marks its session seen`

### Task 8: End to end on two real tmux servers

**Files:**
- Modify: `tests/e2e/fake-openshell.sh`
- Create: `tests/e2e/remote-attach.test.ts`
- Reuse: `tests/e2e/helpers.ts` and the hub/sandbox setup from `tests/e2e/remote-sync.test.ts`

**Interfaces:**
- The fake openshell gains:
  - Every invocation appends its argv to `$FAKE_OS_DIR/calls.log`, tab-joined, one line per call.
  - `exec --tty` runs `"$@"` with the terminal inherited and no stdin drain. `--no-tty` keeps the drain.
  - `sandbox get <name> -o json` prints `$FAKE_OS_DIR/<name>/sandbox.json`, defaulting to `{"phase":"Ready"}`.
  - `sandbox start <name>` exits 0.

- [ ] **Step 1: Write the test.**
  - Setup:
    - A sandbox hub runs under `HOME=$FAKE_OS_DIR/box1`. It has a live session whose tmux coords point at an *inner* server: `-S <tmp>/inner.sock`, `new-session -d -s work 'sleep 600'`, with the stored `tmux_socket` set to that path.
    - The Mac hub has `[[remote]] gateway = "gw"` with `openshell_bin` set to the fake, and syncs the sandbox; wait until `agmux ls --remote` shows the session.
    - An *outer* server, `-S <tmp>/outer.sock`, holds a session `mac`.
  - `view attach builds the remote view`: run `agmux attach <id> --placement new-window --mode view` with `TMUX` pointing at the outer server. Within 5 s:
    - the outer server has a window `⇄ <name>` whose pane has `@agmux_session_id=<id>` and `@agmux_attach_mode=view`;
    - the inner server has `agmux-view-<id8>-p<N>`, holding `work`'s window;
    - `calls.log` contains an `exec -n box1 --tty -- sh -c` line.
  - `second attach switches instead of duplicating`: running it again still leaves one remote window.
  - `closing the local window reaps the view`: `kill-window` on the outer window. Within 5 s the inner view session is gone, and `calls.log` has a `--no-tty -- sh -c` reap line.
  - `full attach adds a client on the agent session`: with `--mode full`, `list-clients -t work` on the inner server gains one client.
  - Skip the file when `tmux` is missing.
- [ ] **Step 2: Run** `bun test tests/e2e/remote-attach.test.ts`. Expected: PASS. Fix the implementation, not the assertions.
- [ ] **Step 3: Run** the full `bun test` and `bun run typecheck`. Expected: green, except the known flake.
- [ ] **Step 4: Commit** `test(remote): attach end to end through a fake openshell and two tmux servers`

### Task 9: Docs

**Files:**
- Modify:
  - `README.md` § Remote sandboxes. Cover:
    - attach, the two modes, `[attach.remote]` (keys and defaults copied from Task 1) and the detach key;
    - `remote_tmux` / `remote_pid` in `inspect`, with a scripting example: `openshell -g <gw> sandbox exec -n <sbx> --tty -- tmux attach -t <session>`;
    - the outer `~/.tmux.conf` settings from spec §8.2: `escape-time 0`, `extended-keys on` + `terminal-features ',xterm*:extkeys'`, `set-clipboard on`, `focus-events on`.
  - `CHANGELOG.md`: Unreleased → Added.
  - `packages/cli/AGENTS.md` (create it if missing): the remote-client and fixed-script mechanism, the reap state and the validation rules.
  - The spec: §10 "Phase 2 implementation notes" (Decisions 1–11), and Status. In §8.1, note that the remote `agmux attach --view|--full|--reap` became fixed sh scripts.
  - `docs/superpowers/plans/2026-10-20-remote-sandbox-sessions-homelab-handoff.md`: add "Phase 2 needs no image change (sh + tmux only)".

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Commit** `docs(remote): phase 2 attach`

### Task 10: Smoke test against a real sandbox

Don't touch the homelab repo. Use a scratch sandbox on `ai-sandbox`: the homelab workbench image, label `agmux=1`, `AGMUX_HOST=ai-sandbox/<name>`. The image's agmux build is fine as it is, because attach needs nothing new inside the sandbox. Don't use `wi-sag-280`, which is a real work item.

**Files:**
- Modify: `docs/spikes/2026-10-11-remote-sandbox/phase1-smoke.sh` (add a `phase2` subcommand) and `SPIKE_REPORT.md` (§ Phase 2 smoke test)

- [ ] **Step 1:** Add a `[[remote]] name = "smoke", gateway = "ai-sandbox"` entry and run `agmux hub restart`. Start the stub agent in the sandbox's tmux (the `phase1-smoke.sh setup` flow), and wait for it in `agmux ls --remote`. `agmux inspect` shows its `remote_tmux`.
- [ ] **Step 2:** In tmux on the Mac, run `agmux attach <id> --placement new-window --mode view`. Check:
  - the stub agent's pane is visible;
  - `M-d` closes the window with no hold;
  - `sandbox exec --no-tty -- tmux ls` shows no `agmux-view-*`.
- [ ] **Step 3:** Attach again, then `kill-window` locally. Within 5 s there is no `agmux-view-*` in the sandbox.
- [ ] **Step 4:** Check `--mode full`: the `C-a` prefix and the status bar are visible, `C-a d` exits 0, and `ps -o comm=` of the recorded pid starts with `tmux` (confirms the reap match).
- [ ] **Step 5:** `openshell sandbox stop <sbx>`, then attach. The sandbox starts first and the attach succeeds; record the latency. If a stopped sandbox drops out of `sandbox list` (its host then turns lost), record that and skip this step.
- [ ] **Step 6:** Record the results, with versions as observed, in SPIKE_REPORT.md. Delete the scratch sandbox, remove the `smoke` remote and restart the hub.
- [ ] **Step 7: Commit** `docs(remote): phase 2 smoke test against ai-sandbox`
- [ ] **Step 8:** Hand the user the by-hand checklist from spec §11, in Ghostty with real Claude: Shift+Enter, Esc latency, mouse wheel into the inner copy-mode, OSC 52 yank. `wi-sag-280` can be used read-only for this once Phase 2 is installed.
