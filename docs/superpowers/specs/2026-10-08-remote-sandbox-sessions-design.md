# Remote Sandbox Sessions — Design

**Date:** 2026-10-08
**Status:** Phase 1 (visibility) implemented 2026-10-20 (see §10 implementation notes). Design: draft, review round 1 incorporated — topology **S** chosen (§5); §6 kept as the
considered alternative. Phase 0 spike findings (2026-10-11,
[`SPIKE_REPORT.md`](../../spikes/2026-10-11-remote-sandbox/SPIKE_REPORT.md)) folded in.
**Builds on:** foundation §2 (B), §3 host-agent role, §7 remote attach, §11 security;
homelab `docs/openshell-handoff.md`, `docs/ai-platform.md`, `docs/openshell-sag-workitem.md`

Agent sessions running in OpenShell sandboxes on `ai-sandbox` (and on the Mac's local
Docker gateway) show up in `agmux ls`, `agmux dash` and the status line next to local
sessions, can be filtered as remote, and can be attached from the Mac in a new tmux window.

---

## 1. Problem

Work-item sandboxes (`wi-SAG-<n>`) run Claude Code under tmux inside an OpenShell
sandbox. Today they are invisible to agmux: the homelab handoff explicitly parks it
("agmux: skip for now (alpha, Bun, macOS-tested)"). To know what a sandboxed agent is
doing you `openshell … sandbox exec --tty -- bash -l` and `tmux attach -t work` by hand,
one sandbox at a time. Attention signals (blocked on a prompt, done) never reach the Mac.

## 2. Goals / non-goals

**Goals**

- G1. Remote sessions appear in `ls`, `dash`, `watch`, status line and notifications
  with the same status model (running / waiting / done / idle / lost) as local ones.
- G2. Filter by locality and host: `--remote`, `--local`, `--host <glob>`; a `host`
  dash column; group/filter in dash.
- G3. `agmux attach` and dash ⏎ on a remote session open a **new local tmux window**
  attached to the remote pane (foreground attach when not inside tmux).
- G4. Foundation principles hold: hub localhost-only, event log is truth, identity
  never invented, tmux first-class.
- G5. Works for the remote gateway (`-g ai-sandbox`) and the Mac-local gateway
  (`-g openshell`) with the same code.

**Non-goals (this spec)**

- Remote spawn (`agmux run` into a sandbox from the dash), remote kill/resume — sketched
  in §10 phase 3, designed later.
- Proxying a terminal stream through the hub (foundation §7 forbids it).
- Postgres / a shared central store. Each node keeps its own SQLite; the Mac replicates.

**Not built now, but designed for** (§4.8 lists the concrete seams)

- Generic SSH hosts (VPS, other machines) as remotes — only the OpenShell transport and
  discovery are built.
- Inter-agent comms (foundation §8) across hosts — needs Mac → remote delivery; only
  remote → Mac replication is built.

## 3. Facts this design rests on

| Fact | Source |
|---|---|
| Events carry `host` (hostname today), `session_id` (UUIDv7), `event_id` (ULID); ingest is idempotent | `protocol/src/events.ts`, `store.resolveAndAppend` |
| Native identity resolves on `(agent_kind, native_session_id, host)` | `store/src/resolve.ts` |
| Liveness sweep is host-scoped: `kill -0` on live native rows **of this host** | `hub/src/liveness.ts`, `store.listLiveNativeSessions(host)` |
| `GET /events?since=<ts>` exists, ordered by local rowid, filtered by `ts >= since` | `hub/src/server.ts`, `store/src/queries.ts` |
| Attach builds tmux argv from stored `tmux_session/window/pane/socket` | `cli/src/attach.ts` `buildAttachCommands` |
| Agent runs under tmux in the sandbox; the session name is not fixed (`work` in the docs, `0` in the real `wi-sag-280`); sandbox main process is `sleep infinity` | homelab `docs/ai-platform.md`, spike |
| Shell into a sandbox: `openshell -g <gw> sandbox exec -n <name> --tty -- <cmd>`; `sandbox connect` attaches to main (`sleep`) and looks like a hang | homelab handoff "Gotchas" |
| `sandbox exec` round trip Mac → `ai-sandbox` 20–30 ms; propagates exit code (death by signal → 1) | spike #9 |
| `exec --no-tty` streams stdout line by line; idle `openshell exec` = 13 MB RSS on the Mac; 20 concurrent execs fine | spike #10, #11 |
| Remote side of an `exec` dies with the local CLI only for `--no-tty` with local stdin held open; closed stdin or `--tty` ⇒ remote orphaned | spike, design change 1 |
| Sandbox hostname = container id; create-time `--env` reaches `exec` processes and tmux panes, image `ENV` does not | spike #6, #7 |
| Bun `fetch` to `127.0.0.1` works under the sandbox proxy env (`NO_PROXY` covers loopback); hub outlives the `exec` that spawned it | spike #3 |
| `sandbox list -o json` → `[{name, id, phase, labels, …}]`; `create --label k=v` (repeatable); `list --selector k=v,…`; no label edit on an existing sandbox at 0.0.116 | homelab `ai-platform.md`, `sag-sandbox-create`, spike #8 |
| `sandbox ssh-config` exists | homelab workitem §5.2 (VERIFIED `--help`) |
| tmux in a sandbox needs `/dev/pts` in `filesystem_policy.read_write` — already in `work-default.yaml` | homelab `ai-platform.md` |
| Egress is default-deny; `protocol: tcp` endpoints need a DNS name (no IP literals); loopback/link-local destinations always blocked | homelab workitem §3 |
| Tools go under `/usr/local/bin` (binary-path policy matching; agent can modify `/sandbox`) | homelab handoff §1 |
| Gateway host `ai-sandbox` 10.10.30.72, amd64, Docker driver, bridge `openshell0` 172.31.250.0/24; Mac reaches it as `ci_user@10.10.30.72` | homelab handoff |
| PTY wrapper is the macOS-only part; native-first capture (hooks → `agmux emit` → HTTP) needs no PTY — verified in `wi-sag-280` (hub, emit, liveness sweep, `bun:sqlite`, x86_64 glibc 2.39) | foundation §4 (superseded note), spike #2–#5 |

---

## 4. Shared model (both topologies)

Both topologies differ only in **where the remote events are captured and stored before
the Mac pulls them**. Everything in this section is identical.

### 4.1 Host naming

A remote session's `host` is `<gateway>/<sandbox>`, e.g. `ai-sandbox/wi-SAG-1234`,
`openshell/scratch`. Container hostnames are not reliable for this (Docker defaults to the
container id; unverified what OpenShell sets), so:

- New env `AGMUX_HOST` overrides `os.hostname()` everywhere agmux stamps `host`
  (`emit`, wrapper, headless). Set by the sandbox launcher (`--env` at create, or
  `/etc/agmux/host` written at create — whichever OpenShell supports at v0.0.116).
- The name is unique per gateway because sandbox names are.

### 4.2 Replication: remote is authoritative, Mac pulls

```
remote store (authoritative for its sessions)          Mac hub (sole writer of Mac DB)
  events(id rowid, event_id, …)  ── pull by cursor ──▶  POST-equivalent: appendReplicated()
                                                          ├─ idempotent on event_id
                                                          └─ projections rebuilt as usual
```

- **Pull, never push to the Mac.** The Mac sleeps, moves networks, and its hub is
  localhost-only. The remote side buffers; the Mac catches up on wake.
- **Cursor = remote rowid**, not `ts`. New query param `GET /events?after_id=<n>&limit=`
  returns `{ events, last_id }`. (`since=<ts>` is lossy under clock skew/equal ts.)
- **Stored envelopes are replicated verbatim** (canonical `session_id` already resolved
  remotely). New store entry point `appendReplicated(env, source)` inserts without
  native-identity resolution, keyed on `event_id`. Projections apply unchanged — they
  are derived from the log by definition (principle 3).
- **Streaming is the primary mode.** `agmux events --follow --after <n>` keeps one
  long-lived `exec` per source emitting NDJSON as events happen; on drop, reconnect with
  the last cursor (backlog pitch 08: snapshot + dedup, no replay).
- **Follower lifetime (spike).** The puller spawns `openshell … exec --no-tty` with a
  **stdin pipe it never closes**: only then does the remote follower die with the local
  process. With stdin closed up front the remote follower is orphaned and keeps running.
  As a second guard, `events --follow --consumer <id>` takes a per-consumer lock in the
  remote state dir and replaces (terminates) a previous follower holding it.
- **Polling is a fallback only** (source where `--follow` keeps failing): exponential
  backoff from `interval` up to a cap, longer for sources whose last event is old.
- **Consumers never trigger sync.** `dash`, `ls`, `watch`, the status line and notifyd
  read the Mac hub's local SQLite exactly as today; remote sessions are ordinary rows.
  Their refresh cadence (e.g. dash's 1 s) is independent of sync cost.

### 4.2.1 Cost model

| Mode | Steady-state cost on the Mac | Latency |
|---|---|---|
| Stream (default) | 1 idle `openshell` CLI process + 1 gateway stream per source; bytes only when hooks fire | ≈ live |
| Poll (fallback) | 1 process spawn + mTLS handshake per source per cycle (measured 20–30 ms Mac → `ai-sandbox`) | `interval` |

At 12 sandboxes: streaming ≈ 12 idle processes × 13 MB ≈ 160 MB on the Mac (measured); 20
concurrent streams hit no gateway cap. Polling at 5 s ≈ 2–3 spawns/s indefinitely —
cheap per call, still only the backoff fallback. If per-source streams
prove fragile or the count grows well past a dozen, a per-gateway relay (§7) collapses
them to one stream per gateway without changing the protocol.

### 4.3 Remotes config, transport, `hosts` projection

`~/.config/agmux/config.toml`:

```toml
[[remote]]
name      = "ai-sandbox"
transport = "openshell"     # openshell | ssh (ssh: G topology / future generic hosts)
gateway   = "ai-sandbox"    # openshell -g <gateway>
selector  = "agmux=1"       # sandbox label selector → auto-discovery
interval  = 5               # seconds; base of the poll-fallback backoff (streaming is default)

[[remote]]
name      = "mac-local"
transport = "openshell"
gateway   = "openshell"
selector  = "agmux=1"
```

A **transport** is one function: `argv(target, cmd[], {tty}) → string[]`, e.g.
`["openshell","-g",gw,"sandbox","exec","-n",sbx,"--tty","--",...cmd]` or
`["ssh","-t",target,...cmd]`. Sync, attach and (later) control all go through it.

New projection `hosts` (additive, rebuildable): `host`, `remote` (config name),
`transport` (json), `last_sync_ts`, `last_sync_ok`, `last_error`, `cursor`, `removed_ts`.
Sync bookkeeping writes to it via additive events (`host.synced`, `host.sync_failed`,
`host.removed`) so it stays log-derived; `host.synced` is coalesced (write on change of
cursor or ok-state only) to keep the log from filling with heartbeats.

The **sync loop runs inside the Mac hub** (the only writer). Discovery each cycle:
`sandbox list -o json` + selector → start/stop per-sandbox pullers (§5) or one
per-gateway puller (§6).

### 4.4 Status and liveness of remote sessions

- **Liveness is decided where the pids live** and arrives as ordinary `session.lost` /
  `session.ended` events. The Mac's sweep is already host-scoped, so it never `kill -0`s
  a remote pid (verify: the sweep's host argument must be the *local* host, never a row's).
- **Unreachable source** (sync failing > 3 intervals): sessions keep their replicated
  status but render with a **stale** marker (`?` glyph / dimmed, "last sync 4m ago" in
  detail). This is a read-time overlay from `hosts.last_sync_ok`, never an invented event.
- **Source removed** (sandbox gone from `sandbox list`): Mac appends `host.removed`;
  `deriveStatus` maps live rows on a removed host to `lost` with rule `host-removed`.
  History stays — the Mac is the archive.
- Wrapper `heartbeat-stale` derivation stays as is; remote native sessions don't use it.

### 4.5 Seen / attention

`session.seen` is **Mac-local**: written to the Mac log against the replicated
`session_id`, never sent back. Remote never emits `seen` for these sessions, so no
conflict. Notifications and status-line chips work unchanged — they read projections.

Focus-to-seen: the local pane-focus hook resolves `--pane %N` to a session; for a remote
view window the local pane carries `@agmux_session_id` (pane option set when agmux opens
the window), and `agmux seen --pane` checks that option first.

### 4.6 CLI / dash surface

- `ls`/`watch`/`dash`: `--remote`, `--local`, `--host <glob>` (hub `/sessions?host=` +
  `locality=`). Config-able defaults under `[ls]`/`[dash]`.
- New dash column `host` (short form `⇄ wi-SAG-1234`; local renders empty) for the
  configurable `columns` list. Dash filter key cycles `all → local → remote`.
- `inspect` shows the host's sync state.
- Status line: remote chips get a `⇄` prefix; click → §4.7.

### 4.7 Attach flow

```
agmux attach <id>   (or dash ⏎ / status-line click)
  └─ row.host is remote?
       no  → existing local path (unchanged)
       yes → already open locally? (a pane with @agmux_session_id=<id>)
               yes → switch-client to it
               no  → in tmux:  tmux new-window -n "⇄ <title>" -- <transport argv --tty> <view cmd>
                      not in tmux: exec the same argv in the foreground
```

`<view cmd>` is defined in §8 and depends on the attach mode (configured default, or
chosen per attach in the dash — §8.4). A stopped sandbox is started first
(`openshell sandbox start`, ≈0.2 s). A non-live remote session (resume case) is phase 3;
MVP prints the `exec` command to run it by hand.

### 4.8 Extension seams: SSH hosts and cross-host comms

Not built in this spec; these choices keep both additive later.

**Generic SSH hosts**

- **Transport** is an interface from day one (`argv(target, cmd, {tty})`), with
  `openshell` the only implementation. An `ssh` transport is `["ssh", "-t"?, target, …cmd]`
  (+ ControlMaster options); nothing else in sync/attach knows which transport it uses.
- **Discovery** is a second interface: `list(remote) → [{node, labels}]`. OpenShell
  implements it via `sandbox list -o json` + label selector; an `ssh` remote would be a
  static node list in config (one node = one host running agmux).
- **Host naming** is `<remote>/<node>` generically (`ai-sandbox/wi-SAG-1234`,
  `vps-1/main`), so nothing parses OpenShell semantics out of `host`.
- **The remote side is plain agmux** (topology S), so any Linux host with the binary is a
  node; no OpenShell-specific code runs remotely.

**Cross-host inter-agent comms**

- Session ids are globally unique (UUIDv7), so a message event addressed to a remote
  `session_id` is already unambiguous on every node.
- Replication is written **direction-agnostic**: `agmux events --follow` (out) and
  `appendReplicated` (in) are the same protocol a node would use in the other direction.
  Mac → remote delivery later = the Mac streaming events into
  `exec -- agmux replicate --in` on the remote, filtered to message events addressed to
  sessions on that node.
- **Loop prevention rule, fixed now:** a node exports only events it ingested itself;
  replicated-in events are never replicated back out. Enforced by `appendReplicated`
  recording the source node on the row and `events --follow` excluding rows that have one.
- Agent inboxes stay local to the agent's node (MCP reads its own hub, foundation §8); the
  Mac becomes the router between nodes. No agent ever talks to another node directly.

### 4.9 Binary delivery and version skew

Requirements (review): new agmux releases adopted quickly without ceremony; sandbox
creation never slowed down by it and never failing when GitHub is down. Uploading the
binary at sandbox create is ruled out.

Key fact: whatever goes into the image lands there at **image build** (Ansible on the
gateway host, or `--from` build on the Mac), never at **sandbox create**. Create uses the
locally built image, so it is never slowed down and never depends on GitHub.

**Decision (review 2026-10-09): bake the binary into the build context, git-ignored.**
Chosen over downloading a pinned GitHub release in the Dockerfile: no release workflow,
no network at image build, a new version is one local command.

- **Not committed.** `openshell/images/workbench/agmux/` is git-ignored. Committing 60–100
  MB binaries would keep every version in homelab's git history forever (cleanup = history
  rewrite); git-ignored files are deleted like any other file.
- **Staging:** homelab `openshell/bin/stage-agmux [<agmux checkout>]` runs
  `bun install --os='*' --cpu='*'` (cross-compiling the CLI needs opentui's Linux native
  packages; lockfile unchanged) and then `bun build --compile` for `bun-linux-x64` and
  `bun-linux-arm64` from the local agmux checkout (default `~/dawolf/agmux/AGX.git.main`),
  writes `agmux/{agmux,agmux-hub}-linux-{amd64,arm64}` + `agmux/VERSION`. Dockerfile
  copies both to `/usr/local/bin/{agmux,agmux-hub}` for `${TARGETARCH}` (`agmux` spawns
  `agmux-hub` from `PATH`; claude hooks call `agmux` from `PATH`).
- **Size:** `agmux` 128 MB + `agmux-hub` 95 MB per arch (spike). Folding the hub into the
  `agmux` binary (`agmux hub serve`) would halve it; worth doing in Phase 1 if cheap.
- **Reaches the gateway** because the Ansible role copies the build context from the
  controller's working tree (`roles/openshell/tasks/images.yml`, `ansible.builtin.copy
  src:`), git-ignored files included. The role asserts `agmux/VERSION` exists so a build
  without a staged binary fails loudly instead of producing an image without agmux.
- **Image tag moves automatically:** `image_tag.py` hashes every file in the build
  context, so a new binary = new tag = rebuild. Mac and gateway derive the same tag
  because Ansible ships the same files.
- **Rollback / retention:** the previous image (old tag) stays on each gateway host; keep
  one prior image as backup and prune older ones (`docker image prune` filtered by the
  workbench repository, run by the role after a successful build). The staged binary
  itself needs no retention — it is rebuildable from the agmux tag in `VERSION`.
- **Trade-off accepted:** the image contains whatever the local checkout built, so
  `stage-agmux` refuses a dirty agmux tree unless `--dirty` is passed, and `VERSION`
  records `git describe` of the checkout.

**Version skew.** Mac and sandboxes will run different agmux versions (older images stay
around). Rules:

- `agmux events` output starts with a header line `{replication: <n>, agmux: <ver>}`.
  The Mac accepts any `replication` ≤ its own; events are additive (principle 7), unknown
  kinds stored raw.
- A remote with a **newer** `replication` than the Mac is synced read-only-best-effort and
  flagged in `inspect` / `hub status` ("remote newer than local, update agmux").
- Remote agmux version is recorded on the `hosts` row and shown in `inspect`.

---

## 5. Topology S — agmux inside each sandbox (chosen)

```
 Mac                                         ai-sandbox (gateway host)
 ┌─────────────────────────┐                 ┌──────────────────────────────────────────┐
 │ agmux hub (localhost)   │  openshell exec │  sandbox wi-SAG-1234 (container)         │
 │  ├ sync: per-sandbox ───┼──── mTLS ──────▶│   ┌────────────────────────────────────┐ │
 │  │  puller              │  `agmux events  │   │ claude ─hook─▶ agmux emit          │ │
 │  ├ store (archive)      │   --follow`     │   │                 │ 127.0.0.1         │ │
 │  └ dash / ls / notifyd  │                 │   │                 ▼                   │ │
 │ tmux ─ new-window ──────┼──── exec --tty ▶│   │ agmux hub ── sqlite (/sandbox/...)  │ │
 └─────────────────────────┘                 │   │ tmux server (session "work")        │ │
                                             │   └────────────────────────────────────┘ │
                                             │  sandbox wi-SAG-1235 … (same)            │
                                             └──────────────────────────────────────────┘
```

**What runs where**

- Image: `agmux` + `agmux-hub` Linux binaries (amd64 for `ai-sandbox`, arm64 for the Mac
  gateway) in `/usr/local/bin`, baked from the staged build context per §4.9. Nothing personal; config is
  uploaded at create, consistent with the image rule.
- At create (launcher, e.g. `sag-sandbox-create`): `--label agmux=1`,
  `--env AGMUX_HOST=<gateway>/<sandbox>` (verified to reach exec'd processes and tmux
  panes; the container hostname is its id), `agmux adapter install --kind claude` into the
  sandbox's Claude config dir (pure file write, no network).
- In the sandbox: the **same** background hub as on the Mac, localhost-only, SQLite under
  `/sandbox/.local/share/agmux`. Hooks → `agmux emit` → `127.0.0.1` exactly as locally.
  Optional: make `agmux hub` the sandbox main process instead of `sleep infinity`.
- Mac: one puller per discovered sandbox:
  `openshell -g <gw> sandbox exec -n <sbx> --no-tty -- agmux events --follow --after <cursor>`,
  stdin an open pipe (§4.2 follower lifetime).

**Liveness:** in-sandbox sweep, same pid namespace — works unchanged.

**Attach:** the remote side resolves its own fresh coords:
`exec --tty -- agmux attach --view <session_id>` (§8). No stale replicated coords, and
resume-in-place comes for free later.

**Failure modes**

| Event | Effect |
|---|---|
| Mac asleep / offline | remote buffers; Mac catches up from cursor |
| Gateway / VM reboot | sandbox returns (verified), tmux + agent die → in-sandbox hub on restart sweeps → `session.lost` replicated |
| Sandbox deleted before last sync | tail of events lost. Mitigation: finish script runs a final `agmux events --after <cursor>` (or Mac syncs on `host.removed` detection if still reachable) |
| Hub not running in sandbox | `emit` auto-starts it (as on Mac); puller exec gets nonzero → stale marker |

**Pros**

- Zero new ingest/liveness/identity code paths remotely — it *is* agmux, just on Linux.
- Principle 1 holds without amendment: no listener off localhost, no policy change
  (traffic is loopback inside the sandbox; Mac traffic rides the gateway's mTLS).
- No cross-sandbox trust: a sandbox can only write its own store.
- Identical on the Mac-local gateway (G5) and portable to any future host type.
- Remote control later = `exec -- agmux <verb>`; no tmux argv built on the Mac.

**Cons**

- One hub daemon per sandbox (memory: Bun RSS, est. 40–80 MB — measure).
- Binary in every sandbox image (~60–100 MB compressed layer, once per image).
- N persistent execs from the Mac for N sandboxes (idle cost per §4.2.1; fine at a
  dozen, relay past that).
- Linux build of agmux must be maintained (CI target, `bun:sqlite` on Linux).
- Remote history lives in the sandbox until replicated; sandbox delete ⇒ must sync first.

---

## 6. Topology G — agmux on the gateway host (considered, not chosen)

Kept for the record and because a per-gateway **relay** (§7) may still be added on top of
S if per-sandbox streams don't scale.

One aggregator hub per gateway host (`ai-sandbox` VM, a systemd user unit via a new
Ansible role). Sandboxes carry only the `agmux` binary as an **emitter**; the aggregator
owns the store for all sandboxes on that gateway. The Mac pulls one stream per gateway.

```
 Mac                                ai-sandbox VM (gateway host)
 ┌─────────────────────┐            ┌─────────────────────────────────────────────────┐
 │ agmux hub           │   ssh      │ agmux aggregator hub ── sqlite (all sandboxes)  │
 │  └ sync: 1 puller ──┼──────────▶ │   ▲ ingest: G-push (HTTP) or G-spool (exec)     │
 │    per gateway      │ `agmux     │   │                                             │
 │                     │  events    │ ┌─┴──────────────┐  ┌──────────────┐            │
 │ tmux new-window ────┼─ --follow` │ │ wi-SAG-1234    │  │ wi-SAG-1235  │  …         │
 │   (openshell exec   │            │ │ claude─▶emit   │  │ claude─▶emit │            │
 │    --tty, direct)   │            │ │ tmux "work"    │  │ tmux "work"  │            │
 └─────────────────────┘            │ └────────────────┘  └──────────────┘            │
                                    └─────────────────────────────────────────────────┘
```

Two ways for events to get from a sandbox to the aggregator:

### 6.1 G-push — sandboxes POST to the aggregator

- Aggregator listens on the VM's LAN address on a dedicated port; ufw allows only the
  sandbox bridge 172.31.250.0/24.
- Each sandbox policy gets an L7 rule: endpoint `agmux.ai-sandbox.lan.dawolf.eu:<port>`
  (DNS name required; explicit dnsmasq record, since `*.lan.dawolf.eu` wildcards to
  Caddy), `POST /ingest` only, binaries `/usr/local/bin/agmux` only. Listing `agmux`
  (not `claude`) keeps the grant off the agent's other children (binary ancestry rule).
- **Deviates from principle 1** (hub binds a non-loopback address). Needs an explicit
  foundation amendment: "a gateway aggregator may bind a sandbox-bridge-only address".
- **Spoofing:** `host` is self-declared in the envelope; sandbox A could write events as
  sandbox B. Mitigation needs a per-sandbox token (a secret in the sandbox — conflicts
  with the "no secrets in sandboxes" stance) or source-address → sandbox mapping through
  the OpenShell proxy (unknown whether the source survives the proxy).
- `emit` needs `HTTP_PROXY`-aware fetch (Bun honours it — verify through the OpenShell proxy).

### 6.2 G-spool — sandboxes spool, aggregator drains

- `agmux emit` with no hub configured appends to a local NDJSON spool
  (`/sandbox/.local/state/agmux/spool/`); no network at all.
- Aggregator, running next to the gateway, drains each sandbox through the local gateway
  (`openshell sandbox exec -n <sbx> -- agmux spool drain --after <n>`), resolves native
  identity at ingest (correct: resolution already happens at ingest today).
- No listener, no policy change, no spoofing (aggregator knows which sandbox it drained).
- It is S's pull loop moved from the Mac to the VM, with the store moved out of the sandbox.

### 6.3 Shared G properties

- **Liveness:** the aggregator cannot `kill -0` container pids (different pid namespace).
  Needs per-sandbox `exec -- agmux probe` (batch `kill -0` + `tmux has-session`) per
  cycle, plus `sandbox list` phase (sandbox gone/stopped ⇒ `session.lost`).
- **Mac transport:** `ssh ci_user@10.10.30.72 agmux events --follow --after <n>` — one
  stream per gateway. (`ci_user` is effectively root via the docker group; a dedicated
  low-privilege `agmux` account for the aggregator is cleaner.)
- **Attach:** still per sandbox, direct from the Mac (`openshell -g … exec --tty`), not via
  the aggregator. The Mac builds the tmux argv from replicated coords, or calls
  `agmux attach --view` in the sandbox (needs the binary there anyway — it is, as emitter).
- **Mac-local gateway:** the Mac hub *is* that gateway's host → it plays aggregator for
  `-g openshell` sandboxes itself (G-spool drain loop in the Mac hub). Symmetric but a
  second code path next to the local one.

**Pros**

- One sync stream per gateway; Mac work independent of sandbox count.
- History survives sandbox deletion without a final-sync step.
- One process per gateway instead of one per sandbox; sandbox stays thinner at runtime.
- Natural home for future gateway-level control (create/delete sandboxes, scheduled
  sweeps like the babysitting timer).

**Cons**

- New deployable (Ansible role, systemd unit, upgrades in lockstep with sandbox emitters).
- Liveness becomes a remote-probe problem instead of the existing sweep.
- G-push: principle-1 amendment + unsolved spoofing. G-spool: exec-per-sandbox anyway, so
  the "one stream" win is only on the Mac↔VM hop.
- Emitter/aggregator version skew across sandboxes created from older images.
- Mac-local gateway needs the aggregator role inside the Mac hub.

---

## 7. Comparison

| | S (in sandbox) | G-push | G-spool |
|---|---|---|---|
| New remote components | Linux build only | aggregator + Ansible role + policy rule + DNS record | aggregator + Ansible role + spool sink |
| Principle 1 (localhost-only) | ✓ | ✗ needs amendment | ✓ |
| Policy / egress change | none | per-sandbox L7 rule | none |
| Cross-sandbox spoofing | impossible | open problem | impossible |
| Liveness | existing sweep | remote probe via exec | remote probe via exec |
| Mac sync streams | 1 per sandbox | 1 per gateway | 1 per gateway |
| Survives sandbox delete without final sync | ✗ | ✓ | ✗ (unless drained) |
| Mac-local gateway | identical | aggregator role in Mac hub | aggregator role in Mac hub |
| Per-sandbox runtime cost | hub daemon | none | none |
| Remote control later | `exec -- agmux …` | via aggregator or exec | via aggregator or exec |

**Decision: S** (review 2026-10-09). It is the foundation's host-agent role taken literally (same binary, every
host is a node, the Mac replicates) and adds no new trust boundary. G-spool converges on S
anyway — it still needs the binary and an exec per sandbox, just with the drain loop on
the VM. G earns its keep only if (a) sandbox counts grow past what N execs from the Mac
handle comfortably, or (b) gateway-level automation (scheduled agents, babysitting
timers) wants a resident agmux on the VM regardless. Both are additive later: an S
deployment can grow a G aggregator that pulls from sandbox hubs exactly like the Mac does
(the Mac then pulls from the aggregator). The replication protocol (§4.2) is the same at
every hop.

---

## 8. Nested tmux

Attaching to the remote tmux from inside a local tmux window nests two tmux clients. The
default prefix (`C-b`) is eaten by the outer one; two status bars stack; Esc latency
doubles (`escape-time` per layer — Esc is Claude Code's interrupt key); extended keys
(Shift+Enter for a newline in Claude Code), true colour and OSC 52 clipboard must survive
two layers.

### 8.1 Modes

**N1 — transparent view (default inside tmux).** Each attach creates a throw-away remote
session that holds the agent's window (linked, not grouped) and has its own session
options, all set so the inner tmux takes no keys and draws nothing.

> **Do not group (found 2026-10-09).** tmux 3.6a segfaults when a session of a group loses
> its last window (`server_destroy_session_group` → `notify_session` →
> `cmd_find_from_nothing`): an agent alone in its session exiting under a view kills the
> whole tmux server. Build `V` as a plain session holding the agent's window instead —
> `new-session -d -s "$V"` + `link-window -s "$W" -t "$V:"` + `kill-window -t "$V:^"` —
> verified not to crash on agent exit or `kill-window` (3.6a; 3.7c in the spike). The
> block below implements this.

```sh
# run remotely by `agmux attach --view <id>` (S); verified on tmux 3.7c (spike view.sh)
V=agmux-view-<id8>-<tag>         # <tag> chosen by the Mac side (its pane id), for the reap
tmux new-session -d -s "$V" \
  \; set -t "$V" status off \
  \; set -t "$V" prefix None \; set -t "$V" prefix2 None \
  \; set -t "$V" key-table agmux-view \; set -t "$V" mouse on
tmux link-window -s "$W" -t "$V:"      # agent's window, by id
tmux kill-window -t "$V:^"             # the placeholder
tmux select-pane -t "$P"
# -u: exec --tty passes no UTF-8 locale. destroy-unattached only at attach: set on the
# never-attached session it fires on kill-window above and the view is gone (3.7c).
exec tmux -u attach-session -t "$V" \; set -t "$V" destroy-unattached on
```

- The outer (local) tmux owns every key; the remote pane behaves like a local pane.
- Leave with `view_detach_key` (default `M-d`): the view is destroyed
  (`destroy-unattached`), the transport exits 0, the agent's session is untouched.
- **Closing the local window does not end the remote client** (spike: `exec --tty` never
  tears down the remote side, whatever the local signal). The orphaned client keeps the
  view attached and can pin the agent window's size; the remote side cannot tell an
  orphan from a quiet viewer. So the Mac reaps explicitly, for both modes:
  - Remotely, `agmux attach --view|--full` records its tmux client pid under
    `<state>/attach/<tag>` before it execs the client.
  - The local pane process is `agmux attach` (owning the transport), which on SIGHUP/exit
    runs `exec --no-tty -- agmux attach --reap <tag>`: N1 kills the view session
    (verified to free the orphaned client), N2 kills the recorded client pid.
  - A Mac crash or sleep skips that; the next attach with the same `<tag>` reaps first.
- Inner `mouse on`: the outer passes wheel events through to the inner (inner requested
  mouse mode), so scrolling enters the *inner* copy-mode and shows the agent's scrollback.
- Other clients (you in `exec bash -l` + `tmux attach -t <session>`) keep their normal
  prefix and status bar — the options are per-session, and the view is its own session.
- The agent exiting while viewed destroys the view (its only window is gone); the remote
  server survives (verified 3.7c, link-window).
- `agmux-view` binds exactly one key, `[attach] view_detach_key` (default `M-d`) →
  `detach-client`; everything else passes to the pane. Same table as the local view client
  in the attach-popup spec (local views were dropped there; the key comes back with N1).
  Verified: unbound keys in the table reach the pane, including `C-b`, Esc (single
  `1b`), arrows and extended keys.

**N2 — full remote tmux (opt-in, for working sessions).** Attach a normal client to the
agent's remote session (`attach-session -t work`, window/pane selected), with the image's
`/etc/tmux.conf` using `prefix C-a` and its status bar on. You get the full remote tmux —
create/switch sessions, windows and panes in the sandbox — at the cost of a second prefix
and a second status bar. N1 is for checking in on an agent; N2 is for involved work
*inside* the sandbox. Both must stay first-class.

**N3 — outer passthrough toggle (opt-in).** The well-known F12 pattern on the *outer*
tmux: `F12` sets the session's `key-table off`, `prefix None`, dims the status bar; `F12`
in the `off` table restores. Inner keeps the normal `C-b`. `key-table`/`prefix` are
session options, so to make it per *window* agmux would toggle via
`session-window-changed`/`after-select-window` hooks on a `@agmux_remote` window
option. Fiddly; only if N2's second prefix is disliked.

**N4 — no nesting.** Outside tmux, `agmux attach` runs the transport in the foreground and
the remote tmux is the top-level client → plain attach to `work` (no view session needed;
optional `--view` still works). Optionally a config to open a new terminal OS window
instead of a tmux window (Ghostty CLI on macOS — verify), for people who want zero nesting.

**Config**

```toml
[remote.attach]
placement = "new-window"  # default target for ⏎ (attach-popup spec slots)
mode = "view"             # default mode: view (N1) | full (N2) | toggle (N3)
window_name = "⇄ {title}"
```

`agmux attach --placement <p> --mode <view|full|toggle>` overrides per call. Remote `/etc/tmux.conf`
sets `prefix C-a` server-wide; N1's view session overrides it to `None` per session, so
both modes coexist on one remote tmux server.

### 8.2 Terminal settings both layers need

Shipped as the image's `/etc/tmux.conf` (system-wide, not personal config) plus a short
note for the local `~/.tmux.conf` (agmux.tmux can set what it owns):

| Setting | Inner (sandbox) | Outer (Mac) | Why |
|---|---|---|---|
| `escape-time 0` | ✓ | ✓ | Esc = Claude interrupt; delay adds per layer |
| `extended-keys on` + `terminal-features ',xterm*:extkeys'` | ✓ | ✓ | Shift+Enter through two layers — verified (outer 3.6a, inner 3.7c, app requesting modifyOtherKeys 2 → `ESC[27;2;13~`); the inner client's `TERM` is `xterm-256color` under `exec --tty`. Real Claude in Ghostty still to check by hand |
| `default-terminal tmux-256color`, `terminal-features ',tmux*:RGB'` | ✓ | — | truecolor; image needs `tmux-256color` terminfo (`ncurses-term`) |
| `set-clipboard on` | ✓ | ✓ | OSC 52 yank from the remote pane reaches the Mac clipboard (dash-yank spec already assumes SSH) |
| `focus-events on` | ✓ | ✓ | agent UIs + agmux focus-seen |
| `window-size latest` | ✓ | — | a window linked into a view and the agent's session resizes to the active client |

### 8.3 Local window bookkeeping

- Local pane options: `@agmux_session_id=<id>`, `@agmux_remote=1`. Used for dedup (§4.7
  "already open"), focus-seen (§4.5), and status-line styling.
- Window name from `window_name`; agmux sets `automatic-rename off` on that window so the
  outer doesn't rename it to `openshell`.
- If the transport exits non-zero (sandbox stopped mid-session, gateway down), keep the
  pane open with a one-line reason until a key — reuse `holdOnFailure`
  (`packages/cli/src/tmux-place.ts`), so the window doesn't vanish silently.
- The local pane process is `agmux attach` (not `openshell` directly), so it can reap the
  remote view on exit (§8.1).
- Dedup is per mode: an open N1 view window doesn't satisfy an N2 attach request (and
  vice versa); `@agmux_attach_mode` on the local pane records which.

### 8.4 Choosing target and mode from the dash

Designed in its own spec, [`2026-10-09-dash-attach-popup-design.md`](2026-10-09-dash-attach-popup-design.md),
because it applies to local sessions too and can ship first: `A` opens a yank-style
popup listing every attach target (inline / new pane / new window / new session / peek /
new tab / new terminal window); ⏎ keeps using the configured default. For remote rows the
popup header shows `mode: view ⇄ full`, toggled with `m` before picking a target. Remote
targets run the transport (§4.7) in the chosen place; phase 2 here adds the remote column
of that spec's target table.

---

## 9. Security against foundation §11

- Hub localhost-only: **S ✓, G-spool ✓, G-push ✗** (amendment required, §6.1).
- Mac ↔ remote rides the user's transport: OpenShell gateway mTLS (S) or SSH (G).
- No credentials enter sandboxes for agmux in S / G-spool. G-push would need a token or
  accept spoofable host attribution.
- Policy binary rule (G-push only): grant `/usr/local/bin/agmux`, never the agent binary,
  so the grant doesn't cover every process the agent spawns.
- Replicated events are untrusted input from a sandbox (prompts/tool payloads come from an
  agent that may run untrusted code): the Mac validates them like ingest
  (`validateKnownPayload`), stores unknown kinds raw (principle 7), and never executes
  anything from them. Attach argv is built from validated coords (tmux ids `@N`/`%N`,
  session name charset) — never shell-interpolated.

## 10. Phasing

**Phase 0 — spikes (half a day, settle §11 verify list).** Done 2026-10-11 in `wi-sag-280`
(not `scratch`: no tmux, no `/dev/pts`), remainder in §11. Linux agmux binary runs a hub
+ claude hooks; loopback HTTP inside a sandbox works with the proxy env;
`exec` streams `--follow` output; N1 view session behaves (keys, mouse, Shift+Enter, Esc);
`sandbox list` selector JSON shape.

**Phase 1 — visibility.** homelab `stage-agmux`, git-ignored build-context dir,
Dockerfile `COPY`, Ansible assert + image prune (keep one prior); `AGMUX_HOST`; `GET /events?after_id`; `agmux events
[--follow] --after`; `appendReplicated`; `hosts` projection; `[[remote]]` config; sync loop
in the hub; `--remote/--local/--host`; dash `host` column + filter; stale overlay;
`host.removed`; replication header + version-skew handling (§4.9); transport/discovery
interfaces and the loop-prevention rule (§4.8). Launcher changes in homelab (label, env,
adapter install).

**Phase 2 — attach.** `agmux attach --mode view|full` (N1 + N2), `[remote.attach]`; remote attach path in `attach`/dash/status
line; local pane bookkeeping; image `/etc/tmux.conf`; focus-seen for remote panes.

**Phase 3 — control (separate spec).** Remote resume (`exec -- agmux attach` creates the
window remotely, then view), kill, `agmux run` into a sandbox from the dash, final-sync
hook in `sag-sandbox-finish`.

**Later (own specs).** SSH transport + static discovery (§4.8); cross-host comms via
Mac-routed downstream replication (§4.8); per-gateway relay if stream count demands it.

### Phase 1 implementation notes

Refinements made while implementing; the code is authoritative.

1. Host naming is discovery's job: `<gateway>/<sandbox>` (`hub/src/sync/discovery.ts`); `[[remote]].name` is only a config key. Resolves §4.1 vs §4.8.
2. Poll fallback = follower reconnect with exponential backoff, `interval` to 300 s (`hub/src/sync/follower.ts`).
3. `host.*` events use `session_id = NO_SESSION_ID` and `host` = the subject host (`protocol/src/host.ts`).
4. Remote rows are read-only: the query layer nulls `pid`/`tmux_*` (`store/src/queries.ts` `decodeRow`); `attach`/`resume`/`kill` refuse (`cli/src/remote-guard.ts`).
5. Strict ingest: reject wrong `host`, foreign `session_id`, `host.*` kinds; a header with another `host` fails the stream (`hub/src/sync/ingest.ts`).
6. `db_id` in `_meta` and in the header; a change resets the cursor to 0 (`store/src/index.ts` `dbId`, `follower.ts` `onHeader`).
7. `dedup_key` is not replicated (stored NULL) (`Store.appendReplicated`).
8. Cursor flush is debounced to 10 s (`host.synced`), plus on stream end / connected-to-failing (`hub/src/sync/sync-loop.ts`).
9. `agmux events --follow` polls the hub every 500 ms, keepalive after 15 s idle; the follower's watchdog is 60 s (`cli/src/events-cmd.ts`, `follower.ts`).
10. Dash `host` column is opt-in; `r` cycles locality client-side (`tui/src/shared/locality.ts`, `cli/src/dash.ts`).
- R2: `agmux events --limit` defaults to 500 and is capped at the hub's 5000 page max.
- R3: the sandbox-side consumer id is `resolveHost()` sanitized to `[A-Za-z0-9._-]`, 64 chars (`hub/bin/agmux-hub.ts`).
- R8: `/ingest` rejects `host.*` with 400 `reserved_kind` (`hub/src/server.ts`).
- R10: ingest also rejects with `append failed` when the store throws; reasons are capped at 300 chars (`ingest.ts`).
- R11: `host.synced` is flushed on connected-to-failing, and on stop only for an ok host; `host.removed` needs 2 consecutive successful listings without the node (`sync-loop.ts`).
- R13b: "last sync" renders as `<rel> ago` only for short durations (`tui/src/shared/reltime.ts` `syncAge`, used by `hub status` and dash detail).
- R14: `sanitizeRemoteText` (`protocol/src/host.ts`) strips control chars from sandbox text, applied at the writer and at the sink (`hub-cmd.ts`).
- R17: replicated rows carry the source store's `db_id` (schema v10 `events.source_db` / `sessions.source_db`); a live row whose `source_db` differs from `hosts.db_id` derives `lost` with rule `host-reset`, so a sandbox recreated under the same name never resurrects old sessions (`store/src/lost.ts`).

## 11. Open questions / verify list

**Decided (review 2026-10-09)**

1. Topology: **S** (§5).
2. Binary delivery: **baked into the image from a git-ignored, locally staged build
   context** (§4.9); no upload at create, no GitHub dependency.
3. Nested mode: **N1 default**, configurable; N2 first-class for working sessions; dash
   mode choice designed for (§8.4).
4. Remote history: **kept on the Mac** after sandbox deletion.
5. Opt-in: **per sandbox via label** `agmux=1`.

6. Dash: **`A` opens an attach-target popup** (separate spec, §8.4); `m` toggles the
   remote mode inside it.

**Still open:** none beyond the verify list.

**Verified (Phase 0 spike, 2026-10-11)** — details in the spike report

- Hostname = container id; create-time `--env` reaches exec'd processes and tmux panes.
- Bun `fetch` to `127.0.0.1` works under the proxy env.
- `exec --no-tty` streams incrementally; 20 concurrent execs fine; round trip 20–30 ms;
  idle `openshell exec` 13 MB RSS.
- Compiled binaries + `bun:sqlite` on the workbench image, amd64 (cross-compiled on the Mac).
- tmux: keys pass through the view's key table; agent exit under a link-window view does
  not crash 3.7c; extended keys across two layers (synthetic).
- Hub RSS ≈ 45 MB per sandbox.

**Still to verify**

- A long-lived `exec` over hours / idle gaps up to 1 h, and how it fails when the Mac
  sleeps (spike running).
- Real Claude hooks end to end in a logged-in sandbox.
- arm64 on the Mac gateway.
- By hand in Ghostty with real Claude: Shift+Enter, Esc latency, mouse wheel → inner
  copy-mode, OSC 52.
- G-push only: source attribution through the OpenShell proxy.

## 12. Doc updates when this lands

- Foundation §7: remote attach realised via transport + view session (§8); §2 (B) now has
  a concrete transport. §11 only if G-push is chosen.
- homelab `docs/openshell-handoff.md`: replace "agmux: skip for now" with a pointer here.
- `packages/hub/AGENTS.md`, `packages/cli/AGENTS.md`: replication + transport mechanisms
  (per-package mechanism docs).
