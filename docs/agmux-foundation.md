# agmux — Foundation

**Date:** 2026-05-27
**Status:** Foundational vision. Not an implementation plan. Per-service design docs / PRDs are produced in later, narrower sessions that build on this shared context.

---

## 1. Vision

A single source of truth for all of one user's AI agent sessions — Claude Code, Codex, Gemini, opencode, pi, and any future agent. agmux records each session as it happens and exposes that data to a family of decoupled services: analytics/insights, a usage dashboard, a live-management TUI/CLI, and agent-to-agent orchestration.

Design stance:

- **Local-first, network-ready.** Works fully on one machine with zero infrastructure; scales to agents spread across sandboxes/VMs/VPS without a rewrite.
- **Agent-agnostic by construction.** The common capture path does not depend on any agent's specific features.
- **Decoupled packages.** Install only what you want. The foundation is small; every consumer is optional and additive.

## 2. Deployment Model

- **(A) Baseline — single machine.** All agents and the hub on one host. No network, no auth.
- **(B) Distributed — single user, many hosts.** Agents run in locally-spawned VM/container sandboxes, or on hosts in an intranet / WireGuard / Tailscale mesh.

Every decision must keep (B) reachable without re-architecting, even though (A) is what ships first. (B) is never designed out.

## 3. Architecture Spine

A long-running **hub daemon** is the spine:

- Owns the store (the only writer / schema owner).
- Exposes an **ingest API** (events in) and a **query API** (reads out, for all consumers).
- Same binary also runs a **host-agent role** on remote hosts to execute local control actions and forward events to the hub.

In baseline (A) one process runs both roles on one machine. In (B), host-agents run elsewhere and reach the hub over the user's secure tunnel. Nothing in the data/ingest path assumes co-location.

## 4. Capture Model (Layered)

> **Superseded (2026-06-08):** The wrapper-primary capture/identity stance below is
> superseded by the native-first design: sessions now self-register from their own
> hooks; the hub resolves native identity to a canonical session at ingest. The
> wrapper remains an opt-in launcher.
>
> **Stage 2 (2026-06-09):** the launcher flip is realized — `agmux run` direct-execs an
> adapter-backed agent (it self-registers via its plugin); the PTY wrapper is the
> `--wrapped`/auto fallback (used for adapter-less kinds, or when the plugin isn't
> installed — `run` never installs without consent, it hints and falls back). The
> normalize nesting guard and the projection freeze are now wrapped/claim-scoped.

Two layers feed the same ingest API:

1. **Wrapper (primary).** `agmux run -p <profile>` launches the agent (or `agmux run <command>` for an inline, profile-less launch). Because it spawns the process it reliably captures the exact command, tmux pane/window/session coordinates, cwd, pid, start/end, and emits lifecycle events + heartbeats. PTY passthrough must be transparent (TTY, signals, resize/`SIGWINCH`, exit code). This is the reliable, agent-agnostic backbone — it even works for agents with no hook system.
2. **Native hooks / adapters (optional enrichment).** Per-agent (Claude `SessionStart`, Codex/Gemini/opencode/pi equivalents) adding in-session events (prompts, tool calls, token usage) where the agent supports them. Additive per agent; never required.

## 5. Identity

> **Superseded (2026-06-08):** The wrapper-primary capture/identity stance below is
> superseded by the native-first design: sessions now self-register from their own
> hooks; the hub resolves native identity to a canonical session at ingest. The
> wrapper remains an opt-in launcher.

- agmux **mints a canonical `session_id` (UUID) at spawn** and injects `AGMUX_SESSION_ID` into the child environment.
- The agent's **native session id is stored as an attribute** (`native_session_id`), never the primary key — agmux is not hostage to whether an agent has a stable id.
- **Hard principle:** every present and future integration — hooks, skills, slash-commands, MCP servers, anything — reads `AGMUX_SESSION_ID` and stamps its events with it. Nothing invents its own identity. This is what keeps the unified datasource joinable.

## 6. Data Model

- **One relational database.** SQLite for baseline, accessed directly via `bun:sqlite`. Postgres-portability for (B) is a deferred goal: the swap-to-Postgres interface is **not yet in place** (no dialect abstraction today). The schema is kept simple enough to keep the door open; the abstraction is introduced when (B) actually demands it.
- **Append-only event log is the source of truth.** Every fact is an immutable event (`session.started`, `heartbeat`, `tool.used`, `prompt.sent`, `tmux.reattached`, `message.sent`, `session.ended`, …).
- **Projection tables (`sessions`, `hosts`, …) are derived** from the log, maintained by the hub as events arrive, and rebuildable at any time. Consumers needing live state read the fast projection; analytics reads the raw log.
- **Unified, not two stores.** Event log and projections live in the same DB and relate by key — every event carries a `session_id` FK into `sessions`. One datasource.

Key session attributes:

- `session_id` (canonical UUID, PK)
- `agent_kind` — the underlying agent (e.g. `claude`)
- `profile` (nullable) — the named launch preset (e.g. `claude-work`, `claude-private`); many profiles map to one `agent_kind`
- `native_session_id` (nullable)
- `command`, resolved `env`/config dir, `cwd`, `pid`
- `tmux_session`, `tmux_window`, `tmux_pane` (nullable when not in tmux)
- `host`, `start`, `end`, `status`
- `parent_session_id` (nullable) — delegation/orchestration lineage

### Schema evolution principle

Events are typed and versioned. Evolution is **additive**. Unknown/future event kinds are stored raw so that no out-of-date adapter can corrupt or drop log data.

## 7. Control & Orchestration

Recording flows wrapper/hooks → hub. Management flows the other way: list / inspect / kill / rejoin / switch go hub → host-agent, which acts locally on the target host.

- **tmux is a first-class substrate, not an implementation detail.** The hub can *create* tmux panes/windows/sessions and inject input, not merely read coordinates.
- **Agent-to-agent delegation.** A workflow can spawn a new tmux pane running `agmux run -p <profile>` (a different agent), inject a prompt, and the new session auto-announces with its injected id and a `parent_session_id` link back to the delegator. The delegation graph is queryable from day one.
- **Remote attach/rejoin.** Since attaching needs a TTY on the target host, agmux hands the user the `ssh … tmux attach` invocation (or orchestrates it) rather than proxying a terminal stream through the hub.

## 8. Inter-Agent Communication

Beyond one-shot delegation (§7), agmux supports an ongoing **agent-communications network**: agents join a shared room/network and exchange structured messages — direct messages, room broadcasts, questions that expect answers, and fire-and-forget notifications/events others can react to. Existing live agents can be joined to a room, not just freshly-spawned ones.

- **Messages are events.** Each message is an event (`message.sent`, `message.delivered`, `question.asked`, `answer.given`, `notification.raised`) carrying sender `session_id`, a target (a session, a room, or broadcast), and a payload. They live in the same append-only log — so comms history is queryable by `insights`/`dashboard` for free, addressed entirely by canonical `session_id`. This reinforces the event-log and `AGMUX_SESSION_ID` decisions rather than straining them.
- **Rooms + membership are an additive schema concept.** A room is a named grouping; sessions join/leave via membership events; a session can belong to several rooms.
- **Delivery is subscribe/MCP, never injection.** Agents receive through an MCP surface (`send_message`, `check_inbox`, `ask`, `reply`, `notify`) backed by the hub — not by injecting text into a tmux pane. Injection stays reserved for spawn/bootstrap (§7); ongoing dialogue is structured and agent-native.
- **Reactivity is bounded by polling cadence.** Delivery is agent-initiated pull — an agent "reacts" when it next checks its inbox (at a turn boundary, or via an adapter that surfaces pending messages at `SessionStart`). True server-push is an optional later optimization, not required by the model — which keeps the hub from needing a mandatory broker.

**Spine impact (§3):** the hub gains a **message-routing role** layered over the existing ingest/query APIs — write a message event, serve it to the addressed sessions' inboxes. It remains localhost/tunnel-bound; no new external surface.

## 9. Runtime & Distribution

- **TypeScript on the Bun runtime.**
- Rationale: npm distribution is satisfiable in any language, so it is not a language constraint; the wrapper's per-launch overhead only matters at single-user-irrelevant scale; TS fluency materially de-risks a long-lived, multi-package, solo-maintained system; one language gives shared types end-to-end (the event/session schema reused everywhere).
- **Bun specifically** so `bun build --compile` can produce single-file binaries for the wrapper and host-agent (closing most of Go's deployment gap) while still publishing to npm.
- **Wrapper is an isolated package** so it can be re-implemented in Go later *without touching anything else* if profiling or portability ever demands it.

### PTY-under-Bun spike (2026-05-27) — GO, with caveats

A feasibility spike confirmed a fully transparent interactive wrapper in TS-on-Bun, including as a `bun build --compile` single binary. All four required capabilities pass: real TTY for the child (`isatty` on fds 0/1/2), size + dynamic `SIGWINCH` propagation, verbatim raw-key/Ctrl-C passthrough, faithful exit-code/signal fidelity (`exit 42`→42, SIGTERM→143, SIGINT→130), and caller-overridable `AGMUX_SESSION_ID` injection.

The load-bearing technical reality — these are wrapper-package implementation constraints, not foundation changes:

- **node-pty is a dead end under Bun** — it loads (prebuilt darwin binary) but `spawn()` throws `posix_spawnp failed`. `Bun.spawn({pty:true})` is silently a no-op (child gets no TTY).
- **The working approach is `openpty()` via `bun:ffi`** (libSystem on macOS) + `Bun.spawn` with the PTY slave fd as stdio.
- **Gotchas to budget for:** one fd can't back all three stdio slots (must `dup` per stream); `bun:ffi` can't call variadic `ioctl`, so window-size needs a non-variadic C shim compiled at runtime via `bun:ffi` `cc()`/TinyCC (and that C source must be inlined + written to a temp file at startup, because `--compile` doesn't bundle `cc()` sources); and the wrapper must `removeAllListeners` before re-raising a signal or its own forwarding handler swallows it.
- **Linux portability is unverified** — needs `libutil.so.1`/libc instead of `libSystem`, and the `TIOCSWINSZ` constant differs. Budget explicit cross-platform work in the wrapper package.
- **Binary baseline ~63 MB** (Bun-compiled, self-contained).

Implication: the wrapper is the most fragile, platform-specific package in the system. This reinforces keeping it strictly isolated behind the ingest API — the Go-rewrite escape hatch is now a more likely future, not just a theoretical one. Treat the spike's `wrapper.ts` approach as the reference for the real implementation.

## 10. Profiles

The wrapper is **profile-aware**: users define an arbitrary number of named launch presets in agmux config (e.g. `claude-work`, `claude-private`), each resolving to a binary + config directory + env + flags. An arbitrary number of profiles map to a smaller set of `agent_kind`s. Both `agent_kind` and `profile` are first-class in the schema so analytics and the TUI can group/filter by either.

## 11. Security

- **Hub binds localhost only. No public interface, ever.**
- Baseline (A) needs no auth — only local processes reach the hub.
- All remote access (B) rides the user's own secure transport: SSH tunnels, WireGuard, Tailscale. Securing that transport is the user's infrastructure, deliberately out of agmux's scope.
- Avoiding an attack surface outranks convenience. Token auth for a directly-exposed hub is a documented opt-in, never part of the baseline.

## 12. Package Decomposition

Each package is independently useful, communicates through a defined interface, and pulls in only what it needs.

**Foundation (non-optional core):**

| Package | Responsibility |
|---|---|
| `@agmux/protocol` | Shared TS types + schema: event/session/host shapes, the `AGMUX_SESSION_ID` contract, event versioning/validation. Zero runtime. Everything imports it. |
| `@agmux/store` | DB layer: schema, migrations, append-only log + projections, query API. SQLite baseline via `bun:sqlite`; the Postgres-swappable interface is deferred until (B) needs it (see §6). No network code. |
| `@agmux/hub` | The daemon: ingest API, query API, projection maintenance, host-agent control role. |

**Capture:**

| Package | Responsibility |
|---|---|
| `@agmux/wrapper` | `agmux run` launcher (`-p <profile>` or an inline command): PTY passthrough, id minting, env injection, lifecycle + heartbeats, profile resolution. Isolated; perf-sensitive. |
| `@agmux/adapters` | Thin per-agent enrichment hooks, each stamping `AGMUX_SESSION_ID`. Optional, additive per agent. |

**Consumers (all optional, all read the hub's query API):**

| Package | Responsibility |
|---|---|
| `@agmux/cli` | Management surface (list/inspect/kill/rejoin/switch) **and** orchestration verbs (spawn-into-tmux, delegate, inject-prompt). Orchestration lives here — the two are inseparable. |
| `@agmux/tui` | Interactive terminal UI for live session management, built on **opentui**. Ships `dash` — a navigable session table (sort/filter/search) with live mirror + detail panes and attach/kill — over the query API. |
| `@agmux/stats` | Web analytics dashboard: usage stats, charts and graphs over the query API. Distinct from the TUI `dash` (live management) — this is the read-only metrics surface. (Was `@agmux/dashboard`.) Planned; not yet built. |
| `@agmux/insights` | Analytics/queries over the event log (historical analysis, delegation graphs). |
| `@agmux/comms` | Inter-agent communication: rooms/membership + an MCP server exposing send/ask/reply/notify and inbox tools, routed through the hub. Optional; turns recorded sessions into a messaging fabric. |

A logging-only user installs `wrapper` + `hub` (which pull `store`/`protocol`). The TUI, web stats, insights, comms, and orchestration are each opt-in.

> **Update (2026-06-26):** Consumer-layer realignment recorded from the first alpha:
>
> - `@agmux/tui` is built on **opentui** (not Ink) and provides **`dash`** — an interactive, navigable terminal UI for live session management (sort/filter/search, live mirror + detail panes, attach/kill). This is the live-management TUI of §1.
> - `@agmux/dashboard` → **`@agmux/stats`**, re-scoped to its original intent: a **web analytics dashboard** (usage stats, charts, graphs) — the usage dashboard of §1. It is separate from and unrelated to the TUI `dash`. Still planned; not yet built.
> - `@agmux/store` ships **SQLite directly via `bun:sqlite`**; the Postgres-portable interface is deferred until (B) needs it (see §6).

### Repository layout

Single **monorepo with Bun workspaces**; every package lives under `packages/*`. Rationale: the protocol is the integration spine, so atomic cross-package changes outweigh the (largely mythical, at this scale) OSS-contribution friction — per-package READMEs, path-scoped CI, and `CODEOWNERS` deliver the focused contributor surface without splitting the repo. Successful precedents: Babel, Biome, Next.js, turbo, Yarn, npm itself.

Deferred (not foundational, flagged here so the structure leaves room):

- **Release strategy** — start lockstep; adopt [changesets](https://github.com/changesets/changesets) the first time a single package needs to ship without bumping the rest.
- **Build orchestration** — plain Bun workspaces suffice until the build graph demands caching; reach for turbo/nx only then.
- **Satellite extraction** — moving a package to its own repo later is cheap; merging back is expensive. So start (A), let (B) emerge only if a package genuinely diverges in technology, cadence, or ownership.

## 13. MVP Slice

The first end-to-end milestone is `protocol + store + hub + wrapper`: **launch an agent through the wrapper, have it recorded in the store, and query it back.** Everything else (adapters, cli, tui, dashboard, insights) layers on top of that working spine.

## 14. Standing Principles (quick reference)

1. localhost-only; no public surface; remote = user's secure tunnel.
2. Canonical id injected via `AGMUX_SESSION_ID`; nothing invents identity.
3. Event log is truth; projections are derived and rebuildable; one unified DB.
4. (B) is never designed out, even though (A) ships first.
5. tmux is a first-class orchestration substrate.
6. Each consumer package is optional; the foundation is small.
7. Event schema evolves additively; unknown events stored raw.
8. `agent_kind` and `profile` are distinct and both first-class.
9. Inter-agent messages are events too; comms delivery is subscribe/MCP, never injection (injection is for spawn/bootstrap only).
