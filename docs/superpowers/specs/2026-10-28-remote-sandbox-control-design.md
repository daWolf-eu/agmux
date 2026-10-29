# Remote Sandbox Control — Design (Phase 3)

**Date:** 2026-10-28
**Status:** implemented (2026-10-29); see [Implementation notes](#implementation-notes)
**Builds on:** [`2026-10-08-remote-sandbox-sessions-design.md`](2026-10-08-remote-sandbox-sessions-design.md)
(Phase 1 visibility, Phase 2 attach — both built; its §10 "Phase 3 — control" is this spec),
foundation §7 (remote attach), §14 (standing principles).

Start and resume agent sessions in OpenShell sandboxes from the Mac, with the same
commands used for local sessions: `agmux run --remote <r> --sandbox <s>` starts an agent
in that sandbox using the remote's configured launch (kind, profile, args, workdir);
resuming a closed remote session (CLI or dash) restarts it in its sandbox, in the tmux
spot nearest to where it ran, and attaches to it.

---

## 1. Intent

The homelab now runs work-item sandboxes on `ai-sandbox` with the agmux image; Phase 1+2
make their sessions visible and attachable from the Mac. What still requires a manual
`openshell … sandbox exec` is *acting* on the agent side: starting a new agent in a
sandbox, and picking a finished/lost one back up. Sandboxes start without any agent;
the agent is started by hand or through agmux. Phase 3 makes a remote sandbox another
place `agmux run` / resume can target.

agmux's focus is the agent side. Sandbox lifecycle (create / stop / delete, images,
policies) is owned by the homelab project — later its own project — and stays there. A
future clean interface to that sandbox project (like the adapter interface) is designed
for, not built.

How the agent is launched in a sandbox *is* agent-side and lives in agmux's `[[remote]]`
config: e.g. `kind = "claude"`, no profile, `args = ["--dangerously-skip-permissions"]` —
the sandbox does the isolation, not the agent.

## 2. Goals / non-goals / anti-goals

**Goals**

- G1. `agmux run --remote <remote> --sandbox <sandbox>` starts an agent in the sandbox's
  tmux using the remote's launch config (overridable per call with the usual `run`
  flags), then attaches locally exactly like a Phase 2 attach (or not, with `-d`).
  `--headless --prompt …` runs it non-interactively and streams output back.
- G2. Resuming a closed remote session (`agmux attach <id>` on a non-live row, dash resume)
  restarts it in the sandbox where it ran, with the same launch (kind/profile/args), placed
  **nearest** to its old spot in the sandbox's tmux (§5.2), then attaches locally. Dash
  behaviour is the same as for local rows; the remote refusal goes away.
- G3. Replicated tmux coords carry a tmux-server identity, so a restarted sandbox tmux
  server is never mistaken for the old one (fixes Phase 2 note 14's stale-attach limit).
- G4. A sandbox can wait until the Mac has stored all its events before it is deleted
  (final sync for `sag-sandbox-finish`).

**Non-goals**

- Killing remote sessions. Never used; `remote kill is not supported yet` stays as is.
- Starting agents from the dash (local or remote) — not part of dash today, not here.
- Sandbox lifecycle beyond what Phase 2 already does (`sandbox start` of a stopped sandbox).
  On-demand sandbox creation is a later feature behind a seam (§5.1.5).
- Shipping Mac-side profiles into sandboxes. `profile` refers to a profile the sandbox's
  own agmux config defines (image-owned).
- Changing local resume placement (it stays "new window in the caller's session").

**Anti-goals** (would be a failure even if it works)

- The Mac inventing session ids or rows for a remote host. Identity is minted where the
  agent runs; the Mac learns about it through replication (foundation: identity never
  invented, event log is truth).
- Terminal streams through the hub (foundation §7).
- agmux knowing about sandbox images, policies or homelab conventions beyond the
  `[[remote]]` config and the `openshell` CLI.
- A resumed agent silently losing its launch args (e.g. coming back *with* permission
  prompts after starting without them).

## 3. Current state (facts)

| Fact | Where |
|---|---|
| `[[remote]]` = `name, transport(openshell), gateway, selector, interval, openshell_bin, agmux_bin`; unknown keys are an error | `hub/src/sync/config.ts` |
| Transport argv: `<bin> -g <gw> sandbox exec -n <sbx> --tty\|--no-tty -- …cmd`; `sandbox get -o json` / `sandbox start` | `hub/src/sync/transport.ts` |
| `exec --no-tty` only starts the command once local stdin hits EOF → spawn with stdin ignored / `/dev/null` | Phase 1 note R19 |
| `sandbox exec` delivers positional args verbatim (spaces, quotes, `;`, `$HOME`, empty) | Phase 2 note 15 |
| Host name of a sandbox is `<gateway>/<sandbox>`; `GET /hosts` gives each host's `TransportSpec` and `remote` config name | Phase 1 note 1, `attach-remote.ts` |
| Remote rows expose `remote_tmux {session, window, pane, socket}` and `remote_pid`; `pid`/`tmux_*` null | Phase 2 note 2 |
| Live remote attach = local pane process `agmux attach <id> --remote-client --mode <m>` running fixed sh scripts in the sandbox; stale coords → script exit 3 | `remote-client.ts`, `remote-tmux.ts` |
| Closed remote row: `attach`/dash refuse with a manual `sandbox exec … agmux attach <id>` hint | `attach-remote.ts` `remoteResumeRefusal`, `dash-actions.ts` |
| Local resume: `buildRelaunchSpec` (native resume via adapter `resumePlan`) → `resumeIntoSession` (new window in caller's session, else new session); always launches through `agmux-wrap` | `relaunch.ts`, `resume-place.ts`, `bin/agmux.ts` |
| Hook-registered rows store `command = agent_kind`, `args = []`, only allow-listed env → a native resume of such a row drops launch args | `store/src/project.ts`, claude adapter |
| `agmux run`: profile (`-p`) or inline command; `--kind`; placements `inherit / new-pane / new-window / new-session / headless`; `-d`; `--prompt` injected after placement; `direct` launch mode runs the agent in the pane without the wrapper; prints `agmux: spawned in s:w.p` | `parse-run.ts`, `run.ts` |
| Wrapper reuses a parent-set `AGMUX_SESSION_ID`, else mints one; headless pre-posts its started event | `wrapper/src/index.ts`, `headless.ts` |
| Hook adapters fill `tmux_socket` from the hook's `$TMUX` (`socket,server_pid,session_idx`) | `adapters/src/adapters/*/normalize.ts` |
| Image ships `agmux` + `agmux-hub` only (no `agmux-wrap`), same build as the Mac; claude hooks installed | homelab handoff §Contract |
| Mac follower for a stopped sandbox backs off up to 300 s | `hub/src/sync/follower.ts` |

## 4. User-facing surface

```
agmux run --remote <remote> --sandbox <sandbox>
          [--kind <k>] [-p <sandbox-profile>] [-- <command> <args…>]   # override the remote's launch
          [--cwd <path>]
          [--new-pane|--new-window|--new-session|-d]                    # local attach placement
          [--headless] [--prompt <text>|--prompt-file <file>]

agmux attach <id>          # closed remote row → remote resume (§5.2), then attach
dash ⏎ / resume action     # same as local rows
```

- `--remote` names a `[[remote]]` entry; `--sandbox` names a sandbox on it. Both required
  together (user's shape; `--sandbox` is the openshell target — a future SSH remote would
  not need it).
- Launch precedence: CLI flags > `[[remote]]` launch keys. `-p` names a **sandbox-side**
  profile. A positional command replaces the configured command + args.
- `--prompt-file` is read on the Mac and sent as prompt text.
- Placement flags and `-d` refer to the **local** attach, resolved like a Phase 2 attach
  (`[attach.remote]` defaults; `--new-pane` etc. override). `-d` = start only, no attach.
  No flag = the `[attach.remote] placement` default; full foreground attach outside tmux
  (Phase 2 note 6).

### Config

```toml
[[remote]]
name    = "ai-sandbox"
gateway = "ai-sandbox"
# NEW, all optional — the launch used by `agmux run --remote ai-sandbox`
workdir = "/sandbox/work"                  # default cwd; --cwd overrides
kind    = "claude"                         # claude | codex | pi
# profile = "…"                            # a profile in the SANDBOX's agmux config; omit = none
# command = "claude"                       # default: the kind's binary
args    = ["--dangerously-skip-permissions"]
```

Validation: `profile` excludes `command`/`args` (same rule as `run -p` vs a positional
command); `kind` required unless `profile` is set; `args` is an array of strings.
No launch keys and no CLI launch flags → `agmux run --remote: no agent configured for
remote R (set kind/profile in [[remote]] or pass --kind/-p)`. The launch applies to every
sandbox on that remote (a remote is one gateway). *(Key names and flat-vs-subtable: my
call; flat avoids the `[remote.x]` TOML nesting trap from Phase 2 note 1.)*

## 5. Design

### 5.1 Remote run

#### 5.1.1 Flow

```
agmux run --remote R --sandbox S [opts]           (Mac)
 1. resolve [[remote]] R → transport + launch (config ⊕ CLI); validate S
 2. sandbox get -o json  → missing: error (§5.1.5) · Stopped: sandbox start (as Phase 2)
 3. transport --no-tty, stdin /dev/null:
      <agmux_bin> run --direct --detach-json [--cwd C] [--prompt T]
                     (--kind K -- <cmd> <args…> | -p P)                    (sandbox)
    → sandbox agmux mints the session id, records the launch, starts the agent in its
      tmux, prints one JSON line:
      {"session_id": "...", "remote_tmux": {session, window, pane, socket, server}}
 4. -d → print "agmux: started <id8> on <host>", exit 0
    else kick the host's follower (§5.1.4), wait until row <session_id> has replicated
    with those coords, then attachRemote(row, placement, mode) — Phase 2 path, unchanged
```

`--headless`: step 3 instead runs the sandbox `agmux run --headless --prompt T …` through
the transport with stdout/stderr streamed through and the remote exit code propagated;
no attach.

Sandbox-side flag names (`--direct`, `--detach-json`) are illustrative — internal to the
Mac↔sandbox contract; the builder picks them.

#### 5.1.2 Sandbox side: direct launch, recorded launch

- **Direct, no wrapper.** The image has no `agmux-wrap`. Sandbox-side start and resume run
  the agent directly in the tmux pane (existing `direct` launch mode); the hooks installed
  in the image report it. A sandbox whose adapter isn't ready errors instead of falling
  back to wrapped mode. *(My call: no image/policy change; claude's process ancestry
  stays as today.)*
- **Recorded launch.** Like headless, the sandbox `agmux run` mints `AGMUX_SESSION_ID`
  and pre-posts a started event carrying `agent_kind`, `profile`, `command`, `args`,
  `cwd`, so the row holds the real launch (not the hook default `command = kind, args = []`).
  The hook's later registration resolves onto that row. This is what makes resume
  reproduce the args (§5.2.1). *(My call.)*

#### 5.1.3 Where it lands in the sandbox

A new window in the sandbox tmux session named by `AGMUX_TMUX_SESSION` (default `agmux`),
created if missing, detached. *(My call: one predictable session for agmux-started agents,
separate from any session started by hand.)*

#### 5.1.4 Waiting for the row

The attach path reads the row from the Mac hub, so the Mac waits for replication of
`session_id` with `remote_tmux` equal to the printed coords. A connected follower makes
this ≈ sub-second, but the follower for a just-started sandbox may sit in backoff (up to
300 s). So before waiting, the CLI asks the local hub to reconnect that host's follower
now (new localhost hub endpoint, e.g. `POST /hosts/<host>/sync`). On timeout (builder's
value, ~15 s) print the session id and an `agmux attach <id8>` hint and exit non-zero; the
start itself has succeeded. The printed coords are a *wait condition*, never written into
the Mac store. *(My call.)*

#### 5.1.5 Missing sandbox / creation seam

A sandbox that `sandbox get` reports missing → `agmux run: sandbox S not found on remote R
(gateway G)`, exit 2. Lookup/start goes through one small interface (e.g.
`SandboxControl { status(target), start(target) }`, Phase 2's get/start calls moved
behind it). A later `ensure(target)` (on-demand creation, provider inferred from the
remote) plugs in here; the future sandbox-project interface replaces the openshell
implementation. Only the interface + openshell `status/start` are built now.

### 5.2 Remote resume

#### 5.2.1 Flow

```
agmux attach <id> / dash resume, row.remote and not live      (Mac)
 1. host → transport + [[remote]] via GET /hosts
    host removed / sandbox missing → error: "sandbox gone; cannot resume" (no recreation)
 2. sandbox Stopped → sandbox start
 3. transport --no-tty, stdin /dev/null:
      <agmux_bin> attach <id> --resume-nearest --detach-json
                  [fallback launch from [[remote]]]                        (sandbox)
    → sandbox agmux resumes its own row and prints {"session_id", "remote_tmux"}
 4. kick follower, wait for the replicated row to be live with those coords, attachRemote
```

The sandbox resumes with its own machinery: `buildRelaunchSpec` (native resume via the
adapter, same `session_id`), launched direct (§5.1.2).

**Launch used on resume:** the row's recorded launch (§5.1.2) if present — profile
(sandbox-side), command and args, plus the adapter's resume args. Rows without one (agent
started by hand in the sandbox) use the fallback launch the Mac passes from the remote's
config. Either way the args survive (anti-goal). Applying a profile's **args** on native
resume is a general fix (today only its env is merged) and applies to local resume too.

#### 5.2.2 Nearest placement (sandbox side)

Given the row's last coords and the current tmux server:

1. same tmux server (identity matches, §5.3) **and** the window still exists →
   `split-window` in that window;
2. else the tmux session (by name) still exists → `new-window` in it;
3. else → `new-session` with the old session name (or the `agmux` default if none).

All detached. After a sandbox stop/start the server is always new → case 3 (or 2 if
something re-created the session). This rule applies only to `--resume-nearest`; local
resume is unchanged.

#### 5.2.3 Live-but-stale remote rows

A remote row can read live while its tmux is gone (sandbox restarted, lost-sweep not yet
run). With server identity in the coords (§5.3), the Phase 2 attach script detects the
mismatch instead of attaching a different agent that reuses `@0`. Preferred (builder's
call on mechanics): treat it like local `decideAttach` — a stale live remote row resumes
instead of failing.

### 5.3 tmux-server identity

Add `server` to the replicated tmux coords (`remote_tmux.server`, and the local capture it
derives from), from `$TMUX`'s second field (server pid) — available wherever `$TMUX` is
already read. If cheap, combine with the server's `#{start_time}` to rule out pid reuse.
Additive protocol field; rows without it are "unknown" (attach as today; nearest-resume
skips case 1).

The Phase 2 view/full scripts compare it against the running server and exit 3 on
mismatch, same as a missing window.

### 5.4 Final sync before deletion

A sandbox-side command that blocks until the Mac has **stored** all events up to the
current head, or a timeout:

```
agmux events --drain --timeout <s>     # exit 0 caught up · non-zero timeout / no consumer
```

"Written to stdout" is not enough: an orphaned `agmux events` (Mac gone) can keep writing
into a dead pipe. Drain uses the Mac's own cursor as the acknowledgement: it SIGTERMs the
live consumer via the consumer lock and waits until the reconnect's `--after <cursor>`
reaches head (the Mac reconnects with its committed cursor). Consumers that count: lock
pid alive, or connected within the last few minutes (a rotation/backoff gap must not read
as "no consumer"). *(My call.)* What the finish script does on a non-zero exit (warn,
keep the sandbox stopped instead of deleting) is homelab's call; agmux only reports.

### 5.5 Version skew

All sandbox-side additions (`--direct`/`--detach-json` on run, `--resume-nearest`,
recorded launch, `--drain`) need the same agmux build in the image. An old sandbox agmux
rejecting an unknown flag must surface on the Mac as
`<host> runs an older agmux; restage the image (stage-agmux)`, not a raw parse error.

## 6. Decisions

**User's**
- Scope: agent-side only — attach (done), resume, start. Sandbox lifecycle stays in
  homelab; a future sandbox-project interface like the adapters.
- `agmux run --remote <r> --sandbox <s>`; door open for on-demand creation later.
- Launch config on `[[remote]]`: `workdir`, `kind`, `profile` (none by default), args
  (e.g. `--dangerously-skip-permissions` — the sandbox isolates, not the agent).
- Sandboxes start without an agent; agents are started by hand or via agmux.
- Resume = restart in the same sandbox, nearest tmux spot (pane → window → session), then attach.
- Dash resume same as local. No dash start. No kill.

**My calls** (marked in text)
- `profile` = sandbox-side profile name; CLI launch flags override the config; flat keys
  with `command`; `--cwd` override (§4).
- Direct launch in the sandbox, no `agmux-wrap`; recorded launch via a pre-posted started
  event (§5.1.2); profile args applied on native resume, locally too (§5.2.1).
- Target tmux session `agmux` (§5.1.3); follower kick + wait-for-replication (§5.1.4);
  `SandboxControl` seam with only status/start (§5.1.5); server identity from `$TMUX`
  (§5.3); `--drain` acknowledged by the Mac's reconnect cursor (§5.4).

**Left to the builder**
- Sandbox-side flag names and JSON shape; timeouts; where nearest-placement code lives
  (shared with `resume-place.ts` or separate); stale-live-row mechanics (§5.2.3); prompt
  size limit for argv transport; how the fallback launch is passed on resume.

## 7. Homelab handoff (separate note, like Phase 1)

- Restage the image with the Phase 3 build.
- `sag-sandbox-finish` calls `agmux events --drain` before delete; decide what a
  non-zero exit means there.
- No image config change needed for the launch (it lives in the Mac's `[[remote]]`); a
  sandbox-side profile is only needed if a remote sets `profile`.

## 8. Done means

- `bun run typecheck` and `bun test` green; e2e with `tests/e2e/fake-openshell.sh` covers
  remote run (config launch, CLI override, attach, `-d`, headless), remote resume (all
  three nearest cases, args preserved, hand-started row with fallback launch), missing
  sandbox, stopped sandbox, old-agmux error.
- Smoke test on `ai-sandbox`: start, detach, resume after `/exit` (still no permission
  prompts), resume after sandbox stop/start.
- Mechanisms documented in `packages/cli/AGENTS.md` / `packages/hub/AGENTS.md`; Phase 3
  implementation notes appended here; the remote-sandbox spec's §10 points to this doc.

## Implementation notes

Refinements made while implementing; the code is authoritative (`cli/src/run-remote.ts`,
`resume-remote.ts`, `resume-nearest.ts`, `run.ts`, `emit.ts`; `hub/src/sync/sandbox-control.ts`).

1. **Coords only, no session id (deviates from §5.1.1).** A direct-launched agent's
   `session_id` is minted by the hub when its hook registers, so there is nothing to print
   up front. `agmux run --direct --print-coords` prints one line
   `{"remote_tmux":{"session","window","pane","socket","server"}}` (`PrintedCoords`). The Mac
   waits (15 s, 500 ms poll) for a row on that host with the printed `pane` and `window`, and
   the printed `server` only when it is non-null (`matchesPrinted`). The recorded launch is
   not a pre-posted started event (§5.1.2) but `AGMUX_LAUNCH` (below), recorded at
   registration.
2. **Resume without a native id or with zero turns** relaunches fresh, and the fresh agent
   registers under a NEW session id (the old row stays closed). So the resume wait also
   matches coords (plus "live remote row"), not the session id.
3. **Fallback launch** for a row without a recorded launch (agent started by hand): from
   `[[remote]]` = `{profile, command: command ?? kind ?? row.agent_kind, args}`, passed as
   `attach <id> --resume-nearest --print-coords --fallback-launch <json>`. No launch keys on
   the remote → no `--fallback-launch`; the row is relaunched as recorded.
4. **Recorded launch:** `AGMUX_LAUNCH` (`{profile, command, args}` JSON, `parseLaunchSpec`) is
   set on every direct start and direct relaunch; `emit` copies it onto
   `session.registered`. The projection takes command/args from a registration only while the
   row still has the hook default (`command = agent_kind`, `args = []`).
5. **tmux server identity:** `TMUX_SERVER_ID_FMT = "#{pid}-#{start_time}"` (protocol
   `attach.ts`), shared by `emit` (registration; falls back to `$TMUX`'s pid), `run
   --print-coords`, `--resume-nearest` and the Phase 2 view/full scripts (exit 3 on a
   mismatch). Rows without it are "unknown": attach as before, nearest-resume skips the split.
6. **Restage detection:** the real guard is the version check against
   `HostRow.agmux_version` before any exec (after the status check, so a deleted sandbox's
   stale host row doesn't report skew; before starting a stopped sandbox, so a refused version
   leaves it stopped): `<host> runs a different agmux version (<remote> vs <local>); restage
   the image (stage-agmux)`. The skew does not stop replication (`checkHeader` checks only the
   host and the replication version), so a Phase 1/2 sandbox keeps syncing. Behind it: an old
   `run` parser fails with `cannot infer agent_kind from '--direct'|'--print-coords'|'--cwd'`
   (exit 2; `--cwd` = headless, whose streamed stderr is teed) → `<host> runs an older agmux;
   restage the image (stage-agmux)`. An
   old sandbox `attach` ignores unknown flags (exit 0, no coords line) → restage message, best
   effort only (that old attach has relaunched the agent the old way). A headless run of an
   old agmux without a `--cwd` runs the old way and is caught only by the version check.
7. `--cwd` is a general `run` flag, headless included; for a remote run it is a sandbox path
   and wins over `[[remote]] workdir`.
8. **Found by the e2e:** a `sandbox exec` client has no UTF-8 locale (Phase 2 already runs
   `tmux -u` for that), and tmux then prints a tab in a format as `_`: every placement call
   that parses tab-separated coords now runs `tmux -u`. And `new-session -e` sets the session
   environment, so a window opened later in the sandbox's `agmux` session (a shell, an agent
   started by hand) inherited the first agent's `AGMUX_LAUNCH`; `newSession` now hands the env
   to the placed command only (`env K=V … cmd`). Both in `cli/src/tmux-place.ts`, local
   placement included.
9. **Known limits:**
   - A live-but-stale remote row (§5.2.3) now fails cleanly through the server check (exit 3)
     but is not auto-resumed. claude has no end hook wired, so after `/exit` the row reads live
     until the sandbox hub's pid sweep (≤ 30 s) has replicated; resume works after that.
   - A kick during an in-flight follower connect skips the backoff after that attempt once; a
     kick while connected does nothing. A kick answered by the endpoint's JSON 404 (host not
     followed: not discovered, or no sync loop) fails the run/resume at once
     (`<host> is not followed by the hub (check [[remote]] selector / sandbox label)`); a plain
     404 (a hub not restarted since the upgrade) still waits. `-d` kicks too and ignores the answer.
   - Prompts with newlines over real openshell are unverified (argv transport; covered by the
     e2e only through the fake) — smoke test.
   - Sandbox names are `[A-Za-z0-9._-]{1,64}` and must not start with `-` (one
     `SANDBOX_NAME_RE` in `cli/src/parse-run.ts`; discovery skips such names too).
   - Claude's first-run dialogs in a fresh workdir (trust the folder, accept
     `--dangerously-skip-permissions`) take the injected prompt; the image or the sandbox
     create must pre-accept them (smoke checklist step 0 in the homelab handoff).
10. **Final-review fixes:**
   - Direct starts check the adapter in the config dir the agent runs with: for a `kind`
     launch the adapter's relaunch keys from the process env (claude: `CLAUDE_CONFIG_DIR` of the
     `sandbox exec` environment), for `-p` the profile's `env` over them (`planLaunch`,
     `cli/src/launch-mode.ts`); the agent is spawned with that same env (`buildDirectSpawn`
     `agentEnv`; a profile launch now passes the profile `env`). `--direct` not ready → exit 2
     naming the dir and `agmux adapter install --kind <k> --config-dir <dir>`. `agmux adapter
     install` reads the same env.
   - `events --drain` SIGTERMs a lagging consumer again once its live pid has held the claim
     for 10 s (at most once per 10 s): a Mac that reconnected behind head streams the rest, but
     `.after` moves only at its next claim.
   - Dash: a remote resume shows `resuming on <host>…` and ignores a second ⏎ on that row
     while it runs.
   - `AGMUX_VERSION` is `0.1.0-alpha.3` (Phase 1/2 builds report `0.1.0-alpha.2`), so the
     version check asks every sandbox on an older image for a restage.
