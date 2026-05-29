# agmux — Adapter Framework Design

**Date:** 2026-05-29
**Status:** Design (spec). Implementation plan is a separate document.
**Builds on:** [`docs/agmux-foundation.md`](../../agmux-foundation.md) (esp. §4 capture model, §5 identity, §6 data model, §10 profiles) and [`docs/superpowers/specs/2026-05-28-mvp-slice-design.md`](2026-05-28-mvp-slice-design.md) (the reserved hooks: `native_session_id`, `running`/`waiting` statuses, `turn.*`/`input.*` event names, `resume_template`).

This spec designs the **adapter framework abstraction only**. No concrete provider is implemented here. Once the abstraction is accepted, a per-provider subagent challenges it against each agent's real architecture (Claude Code, Codex, Gemini/Antigravity, opencode, pi); each provider then gets its own implementation spec.

**Iteration boundary.** This doc commits only to the *agent-agnostic* abstraction. Per-provider specifics — exact hook/event names, which source fulfils which hook-point, install mechanics, known pitfalls — are deliberately **left open for the dedicated per-provider sessions** (§9). Where this spec names a provider, it is *illustrative* (showing why the abstraction needs a given seam), never a committed implementation contract. The abstraction here has already survived one such challenge (an early Codex self-review, §9.1), which is why it is multi-source rather than hooks-only.

---

## 1. Scope

### 1.1 Goal

Define the unified, agent-agnostic abstraction by which agmux ships a first-class integration *expressed in each agent's own surfaces* (plugins / hooks / skills / commands / events — **and** native artifacts like transcript/event files) that feeds **back** into agmux. The integration delivers four capability families:

1. **Native session-id linkage** — record the agent's own session id against the canonical `session_id`.
2. **Runtime-state sync** — drive the projection's `running` / `idle` / `waiting` statuses reliably.
3. **Unified telemetry** — capture token/usage metrics across providers into one normalized shape.
4. **Future agent-agnostic workflows** — a substrate for cross-provider plugins/skills/hooks (e.g. comms inbox check). Reserved, not built in v1.

### 1.2 Design stance

- **Agent does the work natively; agmux provides the integration and a callback target.** An adapter declares one or more **capability sources** (§2.0) — a hook firing a command, a transcript/event file, a JSON stream, MCP, a manual command. The point is to use *whatever native surface a provider exposes*, not to assume every provider has hooks for everything. **No mandatory long-running sidecar / OTEL receiver in v1**: v1 sources are *event-triggered* (a hook invokes the shim, which may also read a bounded file delta at that moment); *continuous* tailers/streams are an additive source mode (§2.0).
- **Pure enrichment.** Everything degrades to today's MVP behavior when no adapter is installed. Nothing the adapter touches is load-bearing.
- **Provider idiosyncrasy is quarantined** in the adapter module — chiefly its source set + `normalize()` — and one orchestration step (`install()`). The hub stays provider-agnostic.
- **Identity is sacred** (foundation §5): every emitted event carries `session_id = AGMUX_SESSION_ID`; an event that can't resolve it is dropped, never sent with a guessed id.

### 1.3 In scope (v1)

- The `@agmux/adapters` package: shared core + the `Adapter` interface (no concrete provider module).
- New canonical event kinds + their payloads (protocol).
- The `agmux emit` callback verb + the `agmux adapter` CLI verb group.
- Projection changes: status state machine + `session_usage` aggregate (store/hub).
- Per-target (profile-aware) install model, capability negotiation, install-state ledger.
- Resume integration via `native_session_id` (closes the MVP resume gap).

### 1.4 Out of scope (deferred, slots reserved)

- **Any concrete provider adapter** — separate specs after the per-provider challenge.
- **MCP transport** — the bidirectional channel for interactive workflows (bullet 4). The manifest is designed so MCP is an additive second transport, not a rewrite.
- **Per-session / ephemeral install** (for sandboxes / isolation) — v1 is install-once-persistent. Future install mode is an additive trait; likely templates the same persistent install.
- **Continuous native-file ↔ store reconciliation** — a *background* read-back/repair pass (and continuous tailer source mode) that backfills usage/turns missed while the hub was down. Distinct from the *event-triggered* transcript-delta reads that v1 sources may do inline (§2.0): the abstraction models transcript reading now; the always-on reconciliation daemon is deferred.
- **Cost/pricing tables** — `cost_usd` stored only if a provider hands it to us; agmux maintains no pricing table (an `insights` concern later).
- **Output/stream capture** — unchanged from MVP exclusions.

---

## 2. Architecture & the core/adapter boundary

`@agmux/adapters` splits into a **shared core** (agent-agnostic) and thin **per-provider adapter modules** (the only place provider knowledge lives). One new CLI surface (`agmux emit`) is the runtime callback target.

```
@agmux/adapters
  core/
    manifest.ts      # canonical vocabulary: hook-points + event kinds we want
    sources.ts       # the CapabilitySource model + activation modes (§2.0)
    registry.ts      # (agent_kind) -> Adapter module lookup
    install.ts       # orchestrates install()/uninstall(); idempotent; writes ledger
    normalize.ts     # raw provider payload (+ source ctx) -> canonical AgmuxEvent[]
    capabilities.ts  # capability declaration + negotiation
    types.ts         # the Adapter interface (the "unified interface")
  adapters/
    claude/          # declares sources; renders install; maps payloads  (follow-on)
    codex/  gemini/  opencode/  pi/                                       (follow-on)
```

### 2.0 Capability sources (the core abstraction)

The central insight (validated by the Codex challenge, §9.1): **a provider's native surfaces are not one uniform "hook" mechanism.** A single capability (e.g. token usage) may be reachable on one agent via a hook and on another only via its transcript file. So an adapter declares a set of **capability sources**, each fulfilling one or more manifest hook-points:

| Source type | What it is | Activation |
|---|---|---|
| `hook-command` | provider fires a configured shell command on a lifecycle event | event-triggered |
| `transcript-delta` | a hook (or `emit` invocation) reads *new* lines of the provider's transcript/event file since a per-session cursor | event-triggered |
| `exec-json-stream` | parse the provider's structured JSONL output stream (e.g. `--json` exec modes) | continuous *(deferred)* |
| `transcript-tail` | a continuous background tailer | continuous *(deferred)* |
| `mcp` | events/queries over an MCP channel | continuous *(deferred)* |
| `manual-command` | user-invoked (`agmux emit ...` by hand / in a script) | on-demand |

**Activation modes** keep the v1 "no mandatory sidecar" promise: v1 ships **event-triggered** sources only (`hook-command`, `transcript-delta`, `manual-command`) — they run only when a provider event fires the shim. **Continuous** sources (tail / stream / mcp) are an additive mode, deferred with the reconciliation daemon (§1.4). A hook-point's *source type is a per-provider detail* (§9): the abstraction only fixes the source *vocabulary* and the normalized output.

### 2.1 The `Adapter` interface (the unified contract)

Every provider module implements:

| Member | Purpose |
|---|---|
| `agentKind: AgentKind` | which `agent_kind` this serves |
| `sources(ctx): CapabilitySource[]` | the source set for this target — each tags which hook-points it fulfils, its type, and its activation mode (§2.0) |
| `capabilities(ctx): CapabilityMap` | derived view: per hook-point, *can-fulfil + by which source* (§6.2) — may differ per profile |
| `install(ctx): InstallRecord` | wire the declared sources into the target's native surfaces (render plugin/hook config, register transcript path, etc.); return an exact record of what changed |
| `uninstall(ctx, record): void` | exact reverse, driven by the recorded `InstallRecord` |
| `status(ctx): InstallStatus` | installed? version? config drift? provider-specific runtime gates (e.g. hook-trust state) |
| `normalize(input): AgmuxEvent[]` | map one raw provider payload into zero-or-more canonical events. `input` carries **runtime context** — `{ point, source, raw, cursor, target, agentVersion }` — and `normalize` returns events plus, for cursor-bearing sources, the advanced cursor (§4.4) |
| `resumePlan(ctx): ResumePlan` | an **opaque resume plan** (argv + cwd + env + native id), not a bare flag string — providers differ (`codex resume <id>` vs a `--resume` flag vs none). Closes the MVP resume gap (§6.4) |

`ctx` (an `InstallContext`) carries the **resolved install target**: `{ agentKind, profile | null, configDir, env, isolationMode }` — produced by reusing the wrapper's profile resolver. `isolationMode` (`config-dir` | `env-gated`, §6.1) tells the adapter how a per-profile install is even achievable on this provider.

### 2.2 Who calls what

- **Install time** (`agmux adapter install`, run once per target): core `install.ts` resolves the target, asks the adapter for its `sources(ctx)`, runs `install()` to wire them, and persists the returned `InstallRecord` — including the derived `CapabilityMap` — to the ledger (§6.3). No event is emitted here (install is not tied to a `session_id`).
- **Runtime**: a provider event fires a source (a hook shelling out to **`agmux emit`** (§4), possibly with a `transcript-delta` read). `emit` runs the adapter's `normalize()` client-side, stamps identity + a deterministic dedup id (§4.4), and POSTs canonical events to the existing hub `/ingest`.
- **The wrapper is untouched** except the one small resume thread-through (§6.4). It already injects `AGMUX_SESSION_ID`; persistent install means the integration reads it at runtime. No per-launch adapter work — the perf-sensitive, fragile wrapper stays isolated per foundation §9.

### 2.3 Consequences

1. **Install is the only mutating, provider-specific orchestration**, and it's out of the hot path: run once, explicit, reversible.
2. **The adapter's source set + `normalize()` are the single quarantine for provider idiosyncrasy** — the exact surface per-provider sessions design and stress-test.
3. **The hub never imports adapter code** — it ingests already-canonical events.

---

## 3. Manifest vocabulary & event contract

The **manifest** is the agent-agnostic middle: the fixed set of hook-points agmux cares about. Each adapter fulfils a subset via its sources (§2.0) — *which source fulfils which hook-point is a per-provider detail*; the manifest fixes only the hook-point vocabulary and the canonical **event kind** each produces on `/ingest`. The hub already stores unknown kinds raw (MVP); v1 teaches the projection to *act* on these.

### 3.1 Canonical hook-points -> event kinds (v1)

| Hook-point | Event kind | Canonical payload | Projection effect |
|---|---|---|---|
| session linked | `session.linked` | `{ native_session_id }` | sets `native_session_id` |
| turn begins | `turn.started` | `{ turn_id?, prompt_chars? }` | `status -> running` |
| turn ends | `turn.ended` | `{ turn_id?, reason }` | `status -> idle` |
| input needed | `input.required` | `{ kind: "prompt"\|"permission"\|"confirm", detail? }` | `status -> waiting` |
| input received | `input.received` | `{}` | `status -> running` (or `idle`) |
| usage reported | `usage.reported` | normalized usage (§3.2) | accumulates `session_usage` |
| tool used | `tool.used` | `{ tool, ok?, detail? }` | log-only (no status change v1) |
| prompt sent | `prompt.sent` | `{ chars?, redacted: true }` | log-only |
| adapter attached | `session.adapter_attached` | `{ agent_kind, profile, adapter_version, capabilities }` | records capabilities for the session (§6) |

`turn.*` / `input.*` names match the MVP spec's reserved contract — no churn. `tool.used` / `prompt.sent` are **optional/log-only**: captured if cheap, but they drive no state, so an adapter skipping them costs nothing.

### 3.2 Normalized usage schema (`usage.reported`)

Every field nullable; an adapter fills what its provider exposes. The schema is intentionally a **superset of common first-party fields** so normalization doesn't erase data providers already give us (the Codex challenge flagged the original as too Claude-centric):

```
{ model?, input_tokens?, output_tokens?,
  reasoning_output_tokens?, total_tokens?,
  cache_read_tokens?, cache_write_tokens?,
  model_context_window?, rate_limit?,
  cost_usd?, turn_id?,
  cumulative: boolean,           // delta (false) vs session-to-date total (true)
  as_of?,                        // provider timestamp the figures are valid at
  source: string }               // which CapabilitySource produced this (e.g. "transcript-delta")
```

`cumulative` distinguishes a per-turn delta (`false`) from a session-to-date total (`true`) — providers report one or the other, and consumers must know which. `as_of` + `source` let consumers reconcile overlapping reports (a hook estimate vs a later transcript-derived total). `cost_usd` stored only if the provider hands it over (§1.4). The exact field set will keep growing as per-provider sessions discover provider-specific figures — additive, all nullable.

### 3.3 Envelope rules

- **Identity:** `session_id = AGMUX_SESSION_ID` on every event; unresolved -> dropped at the shim (§4), never guessed.
- **Versioning:** each new kind is `version: 1`, validated leniently (unknown -> stored raw), so a stale adapter never corrupts the log (foundation §6 schema-evolution principle).

### 3.4 Projection is the authority; adapters are best-effort

The projection treats `turn.*` / `input.*` as a small state machine over live statuses and **ignores illegal/duplicate transitions** (a second `turn.started`, any live transition on an `ended` row). Providers will not emit perfectly-paired events; the projection keeps status sane regardless. Full rules in §5.

---

## 4. The `agmux emit` callback path

`agmux emit` is the **universal inbound surface** — a new stateless `agmux` subcommand. Installed hooks shell out to it; it normalizes and POSTs to the existing hub `/ingest`. No new daemon.

### 4.1 Dumb source, smart emit

The adapter's `install()` bakes the *dumbest possible* call into the provider's surface — pass the raw provider payload through, tagged with origin, source, and hook-point:

```
# example shape an adapter installs into a provider's hook config:
agmux emit --from=<kind> --source=hook-command --point=turn.start   # raw provider JSON on stdin
```

`agmux emit` then:
1. resolves `agent_kind` from `--from`,
2. loads that adapter's `normalize({ point, source, raw: stdin, cursor, target, agentVersion })` -> zero-or-more canonical events (+ advanced cursor for cursor-bearing sources),
3. stamps each with `session_id = $AGMUX_SESSION_ID` + envelope fields (`event_id` ULID, `ts`, `host`, `version`) + a **deterministic dedup id** (§4.4),
4. POSTs to `/ingest`.

**`normalize()` runs client-side, inside `emit`** — so the hub stays provider-agnostic and all idiosyncrasy stays in the adapter package.

### 4.2 Hot-path constraints (runs inside the agent)

1. **Never break the agent's surface.** `emit` *always* exits 0 — bad input, missing env, unreachable hub. A telemetry failure must never fail a user's tool call or block a turn.
2. **Silent on stdout.** Some providers parse a hook's **stdout as hook-protocol output** (the Codex challenge flagged this). `emit` writes *nothing* to stdout; diagnostics go to a debug trace file only.
3. **Never block.** Short timeout (<= the wrapper's, likely shorter); on timeout / network / 5xx, fall back to the queue and return immediately. Fire-and-forget.
4. **Drop, don't guess.** No `AGMUX_SESSION_ID` -> drop the event (debug-trace it), never send with an invented id.
5. **Fast, absolute, trusted.** Installed call sites use an absolute path and must tolerate the provider's hook-trust model; startup latency must stay low. *Implementation option (decide per impl):* ship `emit` as a small dedicated `agmux-emit` binary rather than a subcommand of the full CLI, if CLI startup proves too heavy for the hot path.

### 4.3 Reliability — reuse, don't reinvent

`emit` writes to the **same per-session queue file** the wrapper already owns for write-through fallback: `~/.agmux/queue/<session_id>.jsonl`. Two independent drains already exist and cover it: the wrapper's periodic flush loop (while the session is live) and the hub's **startup drain of *every* `.jsonl` in the queue dir** (`hub/src/drain.ts`, idempotent append). So an event emitted while the hub is briefly down is delivered on the next wrapper flush *or* the next hub startup — no new flush machinery, and no dependence on the *same* session reopening the file. Append-only JSONL keeps concurrent wrapper+emit appends safe.

**Residual edge (accepted, v1):** if the hub stays down *and* no hub restart happens for a long time, post-wrapper-exit events linger in the queue until the next hub startup drains them. Acceptable; the deferred continuous reconciliation (§1.4) is the eventual proactive-backfill path.

### 4.4 Idempotency & dedup

Two layers, because they protect against different things:

- **Transport idempotency:** each event carries a unique `event_id` (ULID); the store's `append` is idempotent on it, so a flushed-*and*-delivered duplicate is a no-op.
- **Source idempotency:** that does **not** stop a source from observing the same fact twice (re-reading a transcript line, a duplicated hook invocation, an agent retry). So cursor-bearing / replayable sources also stamp a **deterministic `dedup_key`** derived from the provider fact — e.g. `<source>:<native_session_id>:<transcript_offset>` or a hash of the native payload + native turn id. The store treats a repeated `dedup_key` as a no-op. Without this, the first transcript-reading adapter would double-count usage. Defining the key is part of each source's per-provider design (§9).

---

## 5. Projection, status, and telemetry storage

The hub's projection (`@agmux/store` `project.ts`) currently handles `session.{started,heartbeat,resumed,ended}`. v1 adds handlers for the new kinds. Two new behaviors: a **status state machine** and a **usage aggregate**.

### 5.1 Status state machine

New live transitions, all guarded:

- `turn.started` -> `running`; `turn.ended` -> `idle`
- `input.required` -> `waiting`; `input.received` -> `running`
- `session.linked` -> sets `native_session_id` (no status change)

Guards (projection is authority; adapters best-effort):

1. Live transitions apply **only when the row is currently live** (`idle`/`running`/`waiting`). A live transition on an `ended`/`lost` row is ignored — never resurrects a dead session.
2. Illegal/duplicate transitions are no-ops (second `turn.started` while `running` = nothing).
3. **`lost` overrides everything.** The existing lost-sweep (no heartbeat past `LOST_THRESHOLD_MS`) marks a row `lost` regardless of `idle`/`running`/`waiting` — a process that dies mid-turn must not be stuck showing `running`. Heartbeat liveness, not turn events, is the ultimate authority on "still alive."

Status now has two independent inputs that compose cleanly: **adapter events refine live state; heartbeat/lost-sweep governs liveness, and always wins.**

### 5.2 Telemetry storage — two-tier

Matching foundation §6 ("projection for live, log for analytics"):

- **Raw `usage.reported` events stay in the append-only log untouched** -> full fidelity for `insights` later (per-turn, per-model, cost recompute).
- **A new `session_usage` projection table** (one row per `session_id`) maintains running totals: `input_tokens`, `output_tokens`, `reasoning_output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `last_model`, `last_rate_limit`, `turn_count`. Upsert honors the payload's `cumulative` flag — `true` replaces totals (provider already summed), `false` adds the delta — and ignores any `usage.reported` whose `dedup_key` was already applied (§4.4). Gives `agmux ls`/`inspect` instant per-session usage without scanning the log. The column set is additive as per-provider sessions surface more figures.

`session_usage` lives beside `sessions`, rebuildable by replaying the log like every other projection. The `sessions` table shape is unchanged (usage is a join when wanted) — keeps the hot row lean.

### 5.3 Migration

One additive migration adds `session_usage` and a `dedup_key` index supporting source idempotency (§4.4) — `dedup_key` is a nullable, uniquely-indexed column on the events table (null = no source-dedup, the common case). `native_session_id` and the `running`/`waiting` status values already exist from MVP. Nothing destructive.

---

## 6. Profile-aware install, capabilities, and resume

### 6.1 Install target is `(agent_kind, profile)`, not `agent_kind`

Profiles are first-class (foundation §10), so install state is tracked per `(agent_kind, profile)` — and the **bare `agent_kind`** (ad-hoc `agmux run claude`, no profile) is its own target, independently installable/uninstallable. But *how* a per-profile install is physically achieved is provider-dependent, so the abstraction supports two **isolation modes** (`ctx.isolationMode`), and the adapter declares which a given provider needs:

- **`config-dir`** — the profile resolves to its *own* native config dir (own settings/hooks/skills). Installing into `claude-work`'s dir leaves bare `claude` and every other profile untouched. Clean isolation by construction.
- **`env-gated`** — the provider layers profiles over **one shared config** rather than separate dirs (the Codex challenge showed `codex -p` layers `$CODEX_HOME/<name>.config.toml` over a shared `$CODEX_HOME`; a globally-installed hook would otherwise fire for *all* profiles and even non-agmux runs). Here the source is installed once into the shared config but **gated at runtime**: the installed call sites are conditioned on an injected `AGMUX_PROFILE` (and `AGMUX_SESSION_ID`) so they only act for agmux-launched sessions of the intended profile.

`install(ctx)` is parameterized by the resolved target (`ctx.configDir` / `ctx.env` / `ctx.isolationMode`, from the wrapper's profile resolver). *Which mode each provider uses, and the exact gating mechanism, is a per-provider detail (§9).* The wrapper injecting `AGMUX_PROFILE` alongside `AGMUX_SESSION_ID` is the one small enabler `env-gated` mode needs.

### 6.2 Capability negotiation

Each adapter declares, **per hook-point and per target**, a *descriptor* — not just a yes/no. Coarse booleans hide distinctions consumers need (the Codex challenge: `turn.start` and `turn.end` can have different fidelity; `input.permission` differs from `input.prompt`; usage-via-hook differs from usage-via-transcript). A descriptor records:

```
"turn.started": {
  fulfil: "yes" | "partial" | "no",
  source: "hook-command" | "transcript-delta" | ...,   // which §2.0 source
  liveness: "live" | "backfilled",                       // real-time vs reconstructed
  minAgentVersion?: string,
  runtimeGate?: "hook-trust" | "none"                    // provider trust/enable state
}
```

Hook-points are addressed at their finest grain (`turn.started`/`turn.ended`, `input.permission`/`input.prompt`) so a provider can be honest about partial coverage. Capabilities can differ across profiles of the same kind, so they're resolved **per target at install time** and stored in the ledger (§6.3). At **session start**, the installed integration emits a `session.adapter_attached` event carrying that session's `{ agent_kind, profile, adapter_version, capabilities }` (stamped with the session's `AGMUX_SESSION_ID`). The projection associates those capabilities with the session, so consumers can answer "is `running`/`waiting` trustworthy for *this* session, or only ever `idle`?" Capability is data, not docs. *The concrete descriptor values per provider are filled in by the per-provider sessions (§9).*

### 6.3 Install-state ledger

`install()` returns an `InstallRecord` (files written, config keys added, plugin version); core persists it per target:

```
~/.agmux/adapters/<agent_kind>[@<profile>].json
```

So `status` (drift detection), `uninstall` (exact reverse), and future re-render on agmux upgrade are all per-target-exact.

### 6.4 Resume integration (closes the MVP gap)

Once `native_session_id` is populated via `session.linked`, `agmux attach` on an `ended`/`lost` session asks the adapter for a `resumePlan(ctx)` and relaunches from it — restoring the *actual* conversation, not a fresh one (the MVP spec named this "the first job of adapters"). The plan is **opaque** (`{ argv, cwd, env, native_session_id }`), not a bare flag string, because providers differ: a subcommand (`codex resume <id>`), a flag (`--resume <id>`), profile flags, or no native resume at all (→ plan signals fall back to fresh relaunch). This is the **one wrapper touch-point**: thread the resume plan into the relaunch path. Small, isolated, separate from the adapter package itself. *Exact per-provider resume invocations are a §9 detail.*

### 6.5 Graceful degradation (default, top to bottom)

- **No adapter installed for a target** -> exactly today's MVP behavior (wrapper lifecycle only; status `idle` until `ended`/`lost`).
- **Adapter installed, capability `"no"`** -> those events never arrive; projection guards already tolerate missing events (no `turn.*` -> stays `idle`).
- Adapter events are *refinements over a working baseline* (§5), never load-bearing.

---

## 7. CLI surface

New `agmux adapter` verb group + the runtime `emit`:

| Command | Action |
|---|---|
| `agmux adapter list` | one row per known target with install state + capabilities (e.g. `claude-work: installed (v3)`, `claude (bare): not installed`) |
| `agmux adapter install <profile>` (or `--kind <agent_kind>` for bare) | resolve target, run `install()`, persist `InstallRecord`; idempotent |
| `agmux adapter status <profile>` | installed? version? config drift? |
| `agmux adapter uninstall <profile>` | exact reverse via recorded `InstallRecord` |
| `agmux emit ...` | runtime callback surface (§4); not user-facing |

---

## 8. Package / contract touch points (summary)

| Package | Change |
|---|---|
| `@agmux/protocol` | new event kinds + payload types (incl. extended usage §3.2, capability descriptors §6.2) + lenient validators; `dedup_key` envelope field |
| `@agmux/store` | `session_usage` table + `dedup_key` unique index + migration; projection handlers + status state machine + lost-sweep precedence (§5); dedup-aware append |
| `@agmux/hub` | none structural — ingests already-canonical events (validators extended via protocol) |
| `@agmux/adapters` | **new package** — core (`types/manifest/sources/registry/install/normalize/capabilities`); no concrete provider in v1 |
| `@agmux/cli` | `agmux adapter` verb group + `agmux emit` (or a dedicated `agmux-emit` binary, §4.2); resume-plan thread-through in `attach` |
| `@agmux/wrapper` | two small touch-points: accept a resume plan on relaunch (§6.4); inject `AGMUX_PROFILE` alongside `AGMUX_SESSION_ID` for `env-gated` installs (§6.1) |

---

## 9. Validation plan (post-acceptance)

Per the chosen approach, dispatch **one session per provider** (Claude Code, Codex, Gemini/Antigravity, opencode, pi) to challenge the abstraction against that provider's real architecture and produce that provider's: **source set** (which §2.0 source fulfils each hook-point), **capability descriptors** (§6.2 values), **isolation mode** (§6.1) and gating mechanism, `dedup_key` scheme (§4.4), `resumePlan` shape (§6.4), and any assumption this spec breaks. Each becomes the provider's own implementation spec. The abstraction-level seams are fixed here; these per-provider details are intentionally left open.

### 9.1 Codex challenge (done early — seeded this revision)

A Codex self-review (run by dogfooding `agmux run … codex exec`) already stress-tested the abstraction and drove the multi-source reframe. Recorded for the eventual Codex impl spec — **provisional, to be verified in that session, not committed here**:

- **Hooks ≠ semantic events.** Codex (v0.135) hook lifecycle resembles Claude's (`SessionStart`, `UserPromptSubmit`, `Stop`, `Pre/PostToolUse`, `PermissionRequest`) — but **no usage hook**, and the native session id is **not** a hook payload field. → `turn.*` partial via prompt/Stop; `input.permission` yes, `input.prompt` no.
- **`session.linked` + `usage.reported` require `transcript-delta`**, not hooks — the figures live only in the transcript/event JSONL.
- **`env-gated` isolation** (§6.1): `codex -p` layers config over a shared `$CODEX_HOME`.
- **Plugins vs hooks are distinct**, with a **hook-trust** step; "a plugin installs hooks" is not a settled contract — install may wire hook config separately and `status()` must report trust state.
- **Hot-path**: Codex may interpret hook **stdout as protocol** → §4.2's silent-stdout rule.

These are inputs to the Codex session, not conclusions of this spec.

---

## 10. Open questions (resolved here, recorded for traceability)

- **Invasiveness** — adapters install into the agent's *own* surfaces (idiomatic), not external observation; install-once persistent. Resolved.
- **Ingress model** — multi-source (§2.0): hooks are *one* source alongside transcript-delta etc.; v1 ships event-triggered sources only, continuous modes deferred. Resolved (revised from hooks-only after the §9.1 Codex challenge).
- **Transport** — `agmux emit` shim (universal, v1), optionally a dedicated `agmux-emit` binary. MCP deferred as additive second transport. Resolved.
- **Authoring shape** — hybrid: shared core + thin per-provider code modules. Resolved.
- **Install granularity** — per `(agent_kind, profile)` target, with `config-dir` *or* `env-gated` isolation per provider (§6.1). Resolved.
- **Per-provider specifics** — source sets, capability values, isolation/gating, dedup keys, resume plans — **intentionally open**, owned by the §9 per-provider sessions.
