# Remote Sandbox Control (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agmux run --remote <r> --sandbox <s>` starts an agent in an OpenShell sandbox with the remote's launch config, and resuming a closed remote session restarts it in the sandbox (nearest tmux spot, same args) and attaches — plus tmux-server identity and a final-sync drain.

**Architecture:** The Mac never builds rows or ids for a sandbox. It runs the sandbox's own `agmux` through the existing transport (`sandbox exec --no-tty`, stdin closed): `agmux run --direct --print-coords …` or `agmux attach <id> --resume-nearest --print-coords …`. The sandbox places the agent in its tmux (direct launch, no wrapper), prints one JSON line of coords, the hooks register the session, replication brings it to the Mac, and the Mac waits for a row with exactly those coords before running the unchanged Phase 2 `attachRemote`.

**Tech Stack:** Bun + TypeScript monorepo (`packages/{protocol,store,hub,adapters,wrapper,tui,cli}`), SQLite store, tmux, `tests/e2e/fake-openshell.sh`.

**Spec:** `docs/superpowers/specs/2026-10-28-remote-sandbox-control-design.md` (read it; this plan argues from it). Predecessor: `docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md` §10 implementation notes.

## Global Constraints

- `bun run typecheck` and `bun test` green after every task (see `CONTRIBUTING.md`).
- Values from a replicated row or config reach a sandbox only as positional argv, validated first (`isRemoteTmux`, `isShellSafeId`, …); never shell-interpolated.
- `sandbox exec --no-tty` callers spawn with stdin ignored (Phase 1 note R19).
- Protocol changes are additive and optional; old rows/payloads without new fields keep working.
- Remote kill stays refused; local resume placement is unchanged.
- Commit messages: `feat(remote): …` / `fix(…)` / `docs(remote): …`, short, no AI attribution lines.
- Code style: match surrounding code (comment density, naming, small focused modules, injectable deps for tmux/process IO as in `attach-remote.ts`).

**Deviation from spec §5.1.1 (recorded here, carried into the spec's implementation notes in Task 12):** a direct-launched agent's `session_id` is minted at hook registration, so `run --print-coords` prints coords only (no `session_id`). The Mac waits for a row on that host whose `remote_tmux.pane` and `remote_tmux.server` equal the printed ones.

## Review Focus

1. A resumed sandbox agent must keep its launch args (e.g. `--dangerously-skip-permissions`), whether it was started via agmux (recorded launch) or by hand (fallback from `[[remote]]`) — Task 4 + Task 6 tests.
2. A sandbox tmux server restarted after stop/start reuses socket path and `@0`: nearest-resume must not split into the "old" window, and a Phase 2 attach must not open a different agent — Task 1, 6, 7 tests.
3. A sandbox running an older agmux (no `--print-coords`) must produce `<host> runs an older agmux; restage the image (stage-agmux)` on the Mac, not a raw parse error — Task 9 test.
4. A just-started (previously stopped) sandbox whose follower sits in backoff must not make the attach time out — Task 8 kick + Task 9 test asserting the kick happens before waiting.
5. Hostile/odd strings: prompt text and args containing spaces, quotes, `;`, `$HOME`, newlines arrive verbatim in the sandbox; sandbox name / remote name outside `[A-Za-z0-9._-]` are rejected before any exec — Task 9 tests.

---

### Task 1: Protocol + store — tmux-server identity and recorded launch fields

**Files:**
- Modify: `packages/protocol/src/attach.ts` (`RemoteTmux`, `isRemoteTmux`), `packages/protocol/src/session.ts` (`SessionRow`), `packages/protocol/src/events.ts` (`SessionRegisteredPayload`)
- Modify: `packages/store/src/schema.ts` (add `SCHEMA_V11`), `packages/store/src/migrations.ts`, `packages/store/src/project.ts` (registered projection), `packages/store/src/queries.ts` (`remoteTmux`, `decodeRow`)
- Test: `packages/protocol/tests/attach.test.ts` (or existing equivalent), `packages/store/tests/project-registered.test.ts` (or existing registered-projection test file)

**Interfaces:**
- Produces:
  - `RemoteTmux.server?: string | null` — server identity `"<pid>-<start_time>"` (or `"<pid>"` when start_time unknown).
  - `isTmuxServerId(s: string): boolean` in `attach.ts` — `/^\d{1,10}(-\d{1,12})?$/`. `isRemoteTmux` accepts `server` absent, `null`, or passing `isTmuxServerId`.
  - `SessionRow.tmux_server: string | null` (local rows; null on remote rows like other `tmux_*`), surfaced on remote rows as `remote_tmux.server`.
  - `SessionRegisteredPayload` optional: `tmux_server?: string | null; command?: string; args?: string[]`.
  - Store column `sessions.tmux_server TEXT` (SCHEMA_V11, migration version 11).
- Projection rules (registered): INSERT writes `tmux_server`, `command = p.command ?? p.agent_kind`, `args_json = p.args ? JSON(p.args) : '[]'`. Revive (ended/lost) and live updates: `tmux_server` overwritten when the payload carries one (COALESCE(new, old)); `args_json` set from `p.args` only when the stored value is `'[]'` (never clobber a recorded launch); `command` likewise only when stored command equals `agent_kind`.

- [ ] **Step 1: Write failing tests**
  - `isRemoteTmux` accepts `{…, server: "123-1730000000"}`, `{…, server: null}`, `{…}` (absent); rejects `server: "12;rm"` and `server: ""`.
  - Projection: registered INSERT with `args: ["--dangerously-skip-permissions"], command: "claude", tmux_server: "42-100"` → row `args = ["--dangerously-skip-permissions"]`, `tmux_server = "42-100"`.
  - Revive: row ended with args `["--x"]`; registered with `args: ["--y"], tmux_server: "43-200"` → args stay `["--x"]`, `tmux_server = "43-200"`, status live.
  - Revive: native row with `args_json '[]'`; registered with `args: ["--y"]` → args `["--y"]`.
  - Replicated (remote) row with `tmux_server` → `decodeRow(...).remote_tmux.server === "42-100"`, `tmux_server === null`.
- [ ] **Step 2: Run** `bun test packages/protocol packages/store` → new tests FAIL.
- [ ] **Step 3: Implement** the types, `SCHEMA_V11 = "ALTER TABLE sessions ADD COLUMN tmux_server TEXT;"`, migration 11, projection, `remoteTmux()` adding `server: clean(raw.tmux_server)`; `appendReplicated` path needs nothing extra if it projects the same events (verify).
- [ ] **Step 4: Run** `bun test packages/protocol packages/store && bun run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(store): tmux server identity and recorded launch on registration`

### Task 2: emit — stamp tmux server and recorded launch on registration

**Files:**
- Modify: `packages/cli/src/emit.ts` (`enrichTmuxCoords` + new `enrichLaunch`), `packages/cli/src/tmux-place.ts` (`resolvePaneCoords` format), `packages/protocol/src/env.ts` or wherever `AGMUX_*_ENV` constants live (add `AGMUX_LAUNCH_ENV = "AGMUX_LAUNCH"`)
- Test: `packages/cli/tests/emit.test.ts`

**Interfaces:**
- Consumes: Task 1 payload fields.
- Produces:
  - `AGMUX_LAUNCH_ENV` constant; value is JSON `LaunchSpec`:
    `export interface LaunchSpec { profile: string | null; command: string; args: string[] }` in `@agmux/protocol` (new `packages/protocol/src/launch.ts`, exported), with `parseLaunchSpec(s: string | undefined): LaunchSpec | null` (null on absent/invalid JSON/wrong types).
  - `resolvePaneCoords` returns `{ session, window, server: string | null }`; format adds `#{pid}-#{start_time}`.
  - `enrichTmuxCoords` sets `payload.tmux_server` from the resolved coords, else from `$TMUX`'s second comma field (pid only).
  - `enrichLaunch(events, env)`: for `session.registered` payloads, when `parseLaunchSpec(env.AGMUX_LAUNCH)` is non-null: `payload.command = spec.command; payload.args = spec.args; payload.profile ??= spec.profile`.

- [ ] **Step 1: Failing tests** — registration with `TMUX="/tmp/tmux-1/default,4242,0"`, resolver returning server `"4242-1730000000"` → payload `tmux_server === "4242-1730000000"`; resolver returning null → `"4242"`. `AGMUX_LAUNCH='{"profile":null,"command":"claude","args":["--dangerously-skip-permissions"]}'` → payload `command`/`args` set; invalid JSON → payload untouched; non-registration events untouched.
- [ ] **Step 2: Run** `bun test packages/cli/tests/emit.test.ts` → FAIL.
- [ ] **Step 3: Implement** as above; call `enrichLaunch` next to `enrichTmuxCoords` (line ~186).
- [ ] **Step 4: Run** tests + typecheck → PASS.
- [ ] **Step 5: Commit** `feat(emit): record tmux server and launch spec on registration`

### Task 3: `[[remote]]` launch config

**Files:**
- Modify: `packages/hub/src/sync/config.ts`
- Test: `packages/hub/tests/sync/config.test.ts` (existing config test file)

**Interfaces:**
- Produces: `RemoteConfig` gains
  `workdir: string | null; launch: RemoteLaunch | null` where
  `export interface RemoteLaunch { kind: AgentKind | null; profile: string | null; command: string | null; args: string[] }`.
  `launch` is null when none of `kind/profile/command/args` is set.
- Rules: keys `workdir, kind, profile, command, args` added to `KEYS`; `kind ∈ claude|codex|pi`; `args` array of strings; `profile` with `command` or `args` → `fail("profile excludes command/args")`; `command`/`args` without `kind` and without `profile` → `fail("kind is required unless profile is set")`; `workdir` non-empty string.

- [ ] **Step 1: Failing tests** — the spec §4 example parses to `{workdir:"/sandbox/work", launch:{kind:"claude", profile:null, command:null, args:["--dangerously-skip-permissions"]}}`; no launch keys → `launch: null`; each rule above throws with the message; `args = "x"` throws `args must be an array of strings`.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS) + typecheck.
- [ ] **Step 5: Commit** `feat(remote): launch config on [[remote]]`

### Task 4: Relaunch — profile args on resume, fallback launch, direct relaunch

**Files:**
- Modify: `packages/cli/src/relaunch.ts`, `packages/cli/src/profile-env.ts` (add profile launch loader beside `loadProfileEnv`)
- Test: `packages/cli/tests/relaunch.test.ts`

**Interfaces:**
- Consumes: `LaunchSpec` (Task 2).
- Produces:
  - `RelaunchOpts.loadProfileLaunch?: (name: string) => { command: string; args: string[]; env: Record<string,string> } | undefined`
  - `RelaunchOpts.fallbackLaunch?: LaunchSpec` — used only when the row has no recorded launch: `session.profile == null && session.args.length === 0 && session.command === session.agent_kind`.
  - Command/args precedence fed into `adapter.resumePlan`: row profile (via `loadProfileLaunch`) → row command/args if recorded → `fallbackLaunch` (its profile via `loadProfileLaunch`, else its command/args) → row as today.
  - `export interface DirectRelaunch { argv: string[]; env: Record<string,string>; cwd: string | undefined; launch: LaunchSpec }`
  - `export function buildDirectRelaunch(session: SessionRow, opts: Omit<RelaunchOpts, "wrapBin"> & { agmuxBin: string }): DirectRelaunch` — same resolution, no wrapper: argv = resume plan argv (or command+args when not resumable), env = session env + `AGMUX_HUB_URL`, `AGMUX_BIN`, `AGMUX_LAUNCH` (JSON of `launch`); **no** `AGMUX_SESSION_ID` (identity comes back via the native id, rule 1 in `store/src/resolve.ts`).
  - `buildRelaunchSpec` behaviour unchanged except the profile-args fix (local resume of a profile row now passes the profile's args to `resumePlan`).

- [ ] **Step 1: Failing tests**
  - profile row `p` whose profile args are `["--model","x"]` → claude resume argv `["claude","--resume",N,"--model","x"]` (both builders).
  - native row (`command:"claude", args:[]`, no profile) + `fallbackLaunch {profile:null, command:"claude", args:["--dangerously-skip-permissions"]}` → argv `["claude","--resume",N,"--dangerously-skip-permissions"]`.
  - row with recorded args `["--a"]` + fallback `["--b"]` → uses `["--a"]`.
  - `buildDirectRelaunch` env has `AGMUX_LAUNCH` parseable to the used launch and no `AGMUX_SESSION_ID`.
- [ ] **Step 2–4:** FAIL → implement (extract a shared `resolveRelaunch` used by both builders) → PASS + typecheck.
- [ ] **Step 5: Commit** `feat(resume): keep launch args on resume, direct relaunch`

### Task 5: Sandbox-side `agmux run --direct --print-coords` and `--cwd`

**Files:**
- Modify: `packages/cli/src/parse-run.ts`, `packages/cli/src/run.ts`, `packages/cli/bin/agmux.ts` (`case "run"`), `packages/cli/src/tmux-place.ts` (server id query helper)
- Test: `packages/cli/tests/parse-run.test.ts`, `packages/cli/tests/run.test.ts`

**Interfaces:**
- Consumes: `AGMUX_LAUNCH_ENV`, `LaunchSpec` (Task 2).
- Produces:
  - `ParsedRun` (profile + inline variants) gain `cwd?: string; direct: boolean; printCoords: boolean`.
  - Flags: `--cwd <path>`; `--direct` (force direct launch; adapter not ready → exit 2 with the adapter hint, no wrapped fallback); `--print-coords` (implies placement `"print-coords"`: new detached window in session `AGMUX_TMUX_SESSION ?? "agmux"`, created with `newSession` if missing; conflicts with other placements and `--headless`; requires `--direct`).
  - `buildDirectSpawn` always adds `AGMUX_LAUNCH` (JSON `{profile, command, args}` of what it launches) and uses `opts.cwd ?? profile.cwd`.
  - `export async function tmuxServerId(pane: string, socket: string | null): Promise<string | null>` in `tmux-place.ts` — `display-message -p -t <pane> '#{pid}-#{start_time}'`.
  - `--print-coords` stdout: exactly one line `JSON.stringify({ remote_tmux: { session, window, pane, socket, server } })`; every other message to stderr. Prompt injection (`--prompt`) still runs after placement.
  - Exported type `PrintedCoords = { remote_tmux: RemoteTmux }` in `@agmux/protocol` (`launch.ts`), with `parsePrintedCoords(line: string): RemoteTmux | null` (validates with `isRemoteTmux`, requires non-null pane).

- [ ] **Step 1: Failing tests** — parse: `--direct --print-coords --cwd /w -- claude --x` ok; `--print-coords` without `--direct` errors; `--print-coords --new-pane` errors; `--print-coords --headless` errors. run (injected tmux deps): print-coords on a missing session calls `newSession`, existing → `newWindow` detached; stdout line parses via `parsePrintedCoords`; spawn env contains `AGMUX_LAUNCH` with the args; cwd from `--cwd` wins over profile cwd.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck.
- [ ] **Step 5: Commit** `feat(run): direct print-coords placement for remote starts`

### Task 6: Sandbox-side resume — `agmux attach <id> --resume-nearest --print-coords`

**Files:**
- Create: `packages/cli/src/resume-nearest.ts`
- Modify: `packages/cli/bin/agmux.ts` (`case "attach"`), `packages/cli/src/attach.ts` (export what is needed only)
- Test: `packages/cli/tests/resume-nearest.test.ts`

**Interfaces:**
- Consumes: `buildDirectRelaunch` (Task 4), `tmuxServerId`, `PrintedCoords` (Task 5), `SessionRow.tmux_server` (Task 1).
- Produces:
  - `export type NearestTarget = { kind: "split"; window: string } | { kind: "window"; session: string } | { kind: "session"; name: string }`
  - `export async function pickNearest(row: Pick<SessionRow,"tmux_session"|"tmux_window"|"tmux_socket"|"tmux_server">, deps: NearestDeps): Promise<NearestTarget>` — rules spec §5.2.2: split only if `row.tmux_server` non-null AND equals the running server id AND the window exists; else `window` if the session exists; else `session` named `row.tmux_session ?? (AGMUX_TMUX_SESSION ?? "agmux")`.
  - `export interface NearestDeps { serverId(socket: string|null): Promise<string|null>; windowExists(win: string, socket: string|null): Promise<boolean>; hasSession(name: string, socket: string|null): Promise<boolean>; splitPane; newWindow; newSession }` (window check compares printed `#{window_id}`, Phase 2 note 12).
  - `export async function resumeNearestCmd(o: { idOrPrefix: string; hubUrl: string; agmuxBin: string; fallbackLaunch: LaunchSpec | null; out(line: string): void }, deps): Promise<number>` — resolves the row on the local hub; refuses remote rows (exit 2); a live row whose tmux session still exists → prints its current coords, exit 0 (nothing to resume); else `buildDirectRelaunch` → place detached at `pickNearest` → print `PrintedCoords` line → exit 0.
  - CLI: `agmux attach <id> --resume-nearest --print-coords [--fallback-launch <json>]` (`--fallback-launch` parsed with `parseLaunchSpec`; invalid → exit 2).

- [ ] **Step 1: Failing tests** for `pickNearest`: same server + window present → split; server differs (restart, same `@0`) → window/session, never split; `tmux_server` null → never split; session gone → session with old name. For `resumeNearestCmd`: printed line parses; fallback launch args appear in the placed argv for a native row; remote row refused.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck.
- [ ] **Step 5: Commit** `feat(resume): nearest-placement resume inside a sandbox`

### Task 7: Phase 2 scripts check the tmux server

**Files:**
- Modify: `packages/cli/src/remote-tmux.ts` (scripts + argv builders), `packages/cli/src/remote-client.ts` (pass `remote_tmux.server`)
- Test: `tests/remote-tmux-scripts.test.ts`, `packages/cli/tests/remote-client.test.ts`

**Interfaces:**
- Consumes: `RemoteTmux.server` (Task 1).
- Produces: the view and full scripts take the server id as an **appended** positional arg (`-` = unknown) and, when known, compare `t display-message -p '#{pid}-#{start_time}'` (or only `#{pid}` when the expected value has no `-`) and exit 3 with `agmux: the sandbox tmux server restarted; the session's window is gone` on mismatch. Argument order of existing params unchanged.

- [ ] **Step 1: Failing test** (real tmux, as the existing script tests do): coords of a window on server A, expected server id from a different value → exit 3 + message; matching id → attaches as before; `-` → as before.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `fix(remote): attach refuses a restarted sandbox tmux server`

### Task 8: Hub — `SandboxControl` seam and follower kick

**Files:**
- Create: `packages/hub/src/sync/sandbox-control.ts`
- Modify: `packages/hub/src/sync/follower.ts` (`kick()`), `packages/hub/src/sync/sync-loop.ts` (`SyncHandle.kick(host)`), `packages/hub/src/server.ts` (route), `packages/hub/bin/agmux-hub.ts` (wire), `packages/hub/src/index.ts` (exports), `packages/cli/src/remote-client.ts` (use the seam for its get/start)
- Test: `packages/hub/tests/sync/sandbox-control.test.ts`, `packages/hub/tests/sync/follower.test.ts`, `packages/hub/tests/server.test.ts`

**Interfaces:**
- Produces:
  - `export type SandboxStatus = { state: "ready" } | { state: "stopped" } | { state: "missing"; detail: string }`
  - `export interface SandboxControl { status(spec: TransportSpec): Promise<SandboxStatus>; start(spec: TransportSpec): Promise<void> }` and `export function openshellControl(capture: typeof runCapture): SandboxControl` — `get -o json` non-zero exit → `missing` with stderr's first line; `phase === "Stopped"` → `stopped`; anything else → `ready`. (Later `ensure()` plugs in here; not built.)
  - `Follower.kick(): void` — if waiting in backoff, cancel the wait and reconnect now; if connected, no-op.
  - `SyncHandle.kick(host: string): boolean` — false when no follower for that host.
  - `POST /hosts/<urlencoded host>/sync` → 204 when kicked, 404 when unknown host / no sync loop.

- [ ] **Step 1: Failing tests** — status mapping (fake capture); follower in backoff with fake timers: `kick()` spawns immediately; server route 204/404.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck. `remote-client.ts` behaviour unchanged (existing tests stay green).
- [ ] **Step 5: Commit** `feat(hub): sandbox control seam and follower kick`

### Task 9: Mac — `agmux run --remote <r> --sandbox <s>`

**Files:**
- Create: `packages/cli/src/run-remote.ts`
- Modify: `packages/cli/src/parse-run.ts`, `packages/cli/bin/agmux.ts` (`case "run"` dispatch before local resolution)
- Test: `packages/cli/tests/run-remote.test.ts`, `packages/cli/tests/parse-run.test.ts`

**Interfaces:**
- Consumes: `RemoteConfig.launch/workdir` (Task 3), `parsePrintedCoords` (Task 5), `SandboxControl`, kick route (Task 8), `attachRemote` (existing), `HostRow.agmux_version`, `VERSION` from `@agmux/protocol`.
- Produces:
  - `ParsedRun` variants gain `remote?: { name: string; sandbox: string }`; a third variant `{ kind: "remote-default"; … }` for `--remote` with no command and no `-p` (launch from config). `--remote` without `--sandbox` (or vice versa) → error; `--sandbox` charset `[A-Za-z0-9._-]{1,64}` else error.
  - `export function resolveRemoteLaunch(parsed, remote: RemoteConfig): LaunchSpec & { kind: AgentKind | null } | { error: string }` — CLI wins; none → `agmux run --remote: no agent configured for remote R (set kind/profile in [[remote]] or pass --kind/-p)`.
  - `export function sandboxRunArgv(remote: RemoteConfig, launch, o: { cwd: string | null; prompt?: string; headless: boolean }): string[]` — `[agmux_bin, "run", "--direct", "--print-coords" | "--headless", ...("--cwd", cwd), ...("--prompt", text), ...(launch.profile ? ["-p", p] : ["--kind", k, "--", command ?? k, ...args])]`.
  - `export async function runRemote(o: RunRemoteOpts, deps: RunRemoteDeps): Promise<number>` — flow spec §5.1.1: resolve remote by name (unknown → exit 2 listing names); version check (host row exists and `agmux_version !== VERSION` → exit 2 with `<host> runs an older agmux; restage the image (stage-agmux)`; also map a sandbox exit 2 whose stderr mentions the unknown flag to the same message); `SandboxControl.status` (missing → `agmux run: sandbox S not found on remote R (gateway G)` exit 2; stopped → start); exec with stdin ignored; parse coords (unparseable → exit 1 with sandbox stderr); `-d` → print `agmux: started on <gw>/<sbx> (<session>:<window>)` exit 0; else POST kick, then poll `/sessions?all=1` (500 ms, timeout 15 s) for a row with `host === "<gw>/<sbx>"` and `remote_tmux.pane/server` equal → `attachRemote(row, req, …)`; timeout → exit 1 with `agmux: started, but the session has not replicated yet; run agmux ls --host <gw>/<sbx>`.
  - Headless: exec `sandboxRunArgv(..., headless: true)` with stdout/stderr inherited, exit with its code; no wait/attach.
  - `--prompt-file` read on the Mac (existing code) and sent as `--prompt`.

- [ ] **Step 1: Failing tests** (injected deps: exec, control, fetch, attachRemote, clock):
  - config launch → argv ends `["--kind","claude","--","claude","--dangerously-skip-permissions"]`; `-p x` → `["-p","x"]`; positional `-- codex --y` with `--kind codex` overrides config.
  - `workdir` → `--cwd /sandbox/work`; `--cwd /o` wins.
  - prompt `a 'b' "c"; $HOME\nd` passed as one argv element unchanged.
  - kick is POSTed before the first `/sessions` poll.
  - wait matches on pane+server and ignores a row with same pane but other server.
  - missing sandbox / old version / unknown remote / bad sandbox name messages and exit codes as above.
  - `-d` never polls or attaches.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck.
- [ ] **Step 5: Commit** `feat(remote): agmux run --remote --sandbox`

### Task 10: Mac — remote resume from `attach` and the dash

**Files:**
- Create: `packages/cli/src/resume-remote.ts`
- Modify: `packages/cli/src/attach.ts` (replace `remoteResumeRefusal` call), `packages/cli/src/dash-actions.ts` (`remoteResume`), `packages/cli/src/attach-remote.ts` (drop `remoteResumeRefusal`/`manualResumeCommand` if unused; keep `remote-guard.ts` for kill)
- Test: `packages/cli/tests/resume-remote.test.ts`, existing attach/dash-actions tests updated

**Interfaces:**
- Consumes: Task 6 CLI contract, Task 8 seam + kick, Task 9's wait helper — extract it in Task 9 as `export async function waitForRemoteRow(o: { hubUrl; fetchImpl; host: string; match: (r: SessionRow) => boolean; timeoutMs: number; pollMs: number; now; sleep }): Promise<SessionRow | null>` in `run-remote.ts`.
- Produces: `export async function resumeRemote(row: SessionRow, req: AttachRequest | undefined, env: { ctx: AttachCtx; settings: AttachSettings; hubUrl: string; remotes: () => RemoteConfig[] }, deps: ResumeRemoteDeps): Promise<Handoff | null>` — host → `HostRow` via `/hosts` (missing or `removed_ts` set → throw `resume: sandbox <host> is gone; cannot resume`); version check as Task 9; status/start; exec `[agmux_bin, "attach", id, "--resume-nearest", "--print-coords", ...(fallback ? ["--fallback-launch", JSON] : [])]` where fallback = the host's `[[remote]].launch` resolved like Task 9; kick; `waitForRemoteRow` matching `session_id === row.session_id` and pane/server equal to printed; then `attachRemote`.
  - `attachCmd`: a closed remote row calls `resumeRemote` (errors → stderr, exit 2). Dash: `remoteResume` calls `resumeRemote` with the dash's ctx/settings.

- [ ] **Step 1: Failing tests** — closed remote row → exec argv as above incl. fallback from config; removed host → error text; waits for the same session id with new coords then calls `attachRemote`; dash resume of a remote row goes through `resumeRemote` (no refusal).
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck.
- [ ] **Step 5: Commit** `feat(remote): resume closed remote sessions`

### Task 11: Sandbox-side `agmux events --drain`

**Files:**
- Modify: `packages/cli/src/events-cmd.ts`, `packages/hub/src/server.ts` (head id, if no existing way)
- Test: `packages/cli/tests/events-cmd.test.ts`

**Interfaces:**
- Produces:
  - Every `agmux events --consumer <c> --after <n>` start writes `<n>` to `<consumers dir>/<c>.after` (same dir as `<c>.pid`).
  - `agmux events --drain [--timeout <s>]` (default 60): head = highest local event id (`GET /events/head` → `{ id: number }`, add if absent); counted consumers = pid alive, or `.after` mtime within 300 s; none → exit 3 `agmux events --drain: no replication consumer`; for each counted consumer with a live pid: SIGTERM it; wait until every counted consumer's `.after` ≥ head → exit 0; timeout → exit 1 naming the lagging consumers.
- [ ] **Step 1: Failing tests** with injected fs/clock/kill/fetch: caught up after a reconnect writing `.after = head` → 0; no consumers → 3; never reconnects → 1 after timeout; a stale consumer (dead pid, old mtime) is ignored.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck.
- [ ] **Step 5: Commit** `feat(events): drain until the Mac has caught up`

### Task 12: E2E, docs, homelab handoff

**Files:**
- Modify: `tests/e2e/fake-openshell.sh` (only if a verb is missing — e.g. `get` of a missing sandbox must exit non-zero with `no sandbox '<name>'` on stderr; it already does), `tests/e2e/helpers.ts`
- Create: `tests/e2e/remote-control.test.ts`
- Modify: `packages/cli/AGENTS.md`, `packages/hub/AGENTS.md`, `docs/superpowers/specs/2026-10-28-remote-sandbox-control-design.md` (status + "Implementation notes" incl. the coords-only deviation and any other refinements), `docs/superpowers/specs/2026-10-08-remote-sandbox-sessions-design.md` (§10 Phase 3 → pointer to the new spec; Phase 2 note 14's stale-coords limit → fixed by server identity). Record as a known limit: a live-but-stale remote row (spec §5.2.3) now fails cleanly via the server check; auto-resume of it is not built
- Create: `docs/superpowers/plans/2026-10-29-remote-sandbox-control-homelab-handoff.md` (spec §7: restage; `sag-sandbox-finish` calls `agmux events --drain --timeout <s>` before delete and decides on non-zero; no image config needed unless a remote sets `profile`)

- [ ] **Step 1: Write e2e** (pattern of `remote-attach.test.ts` / `remote-sync.test.ts`, fake openshell, real tmux, stub agent with hooks as those tests do): remote run `-d` with config launch → replicated row with recorded args; remote run with attach → local window with the remote-client pane; headless remote run exit code propagates; resume after the stub exits → same `session_id` live again with new coords, args preserved; resume after killing the sandbox tmux server → new session (not split); missing sandbox message.
- [ ] **Step 2: Run** `bun test tests/e2e/remote-control.test.ts` → PASS (fix forward in the owning task's files if not).
- [ ] **Step 3: Docs** as listed; mechanisms per package (cli: remote run/resume contract, `AGMUX_LAUNCH`, print-coords; hub: SandboxControl, kick route).
- [ ] **Step 4: Run** `bun run typecheck && bun test` → all green.
- [ ] **Step 5: Commit** `docs(remote): phase 3 notes and homelab handoff` (tests may go in a separate `test(remote): …` commit).
