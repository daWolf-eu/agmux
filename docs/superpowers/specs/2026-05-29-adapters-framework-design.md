# agmux — Adapter Framework Design

**Date:** 2026-05-29
**Status:** Design (spec). Implementation plan is a separate document.
**Builds on:** [`docs/agmux-foundation.md`](../../agmux-foundation.md) (esp. §4 capture model, §5 identity, §6 data model, §10 profiles) and [`docs/superpowers/specs/2026-05-28-mvp-slice-design.md`](2026-05-28-mvp-slice-design.md) (the reserved hooks: `native_session_id`, `running`/`waiting` statuses, `turn.*`/`input.*` event names, `resume_template`).

This spec designs the **adapter framework abstraction only**. No concrete provider is implemented here. Once the abstraction is accepted, a per-provider subagent challenges it against each agent's real architecture (Claude Code, Codex, Gemini/Antigravity, opencode, pi); each provider then gets its own implementation spec.

---

## 1. Scope

### 1.1 Goal

Define the unified, agent-agnostic abstraction by which agmux ships a first-class integration *expressed in each agent's own extension system* (plugins / hooks / skills / commands / events) that calls **back** into agmux. The integration delivers four capability families, all through one mechanism:

1. **Native session-id linkage** — record the agent's own session id against the canonical `session_id`.
2. **Runtime-state sync** — drive the projection's `running` / `idle` / `waiting` statuses reliably.
3. **Unified telemetry** — capture token/usage metrics across providers into one normalized shape.
4. **Future agent-agnostic workflows** — a substrate for cross-provider plugins/skills/hooks (e.g. comms inbox check). Reserved, not built in v1.

### 1.2 Design stance

- **Agent does the work natively; agmux provides the bundle and a callback target.** Not an external observer (no mandatory file-tailing / OTEL receiver / sidecar in v1).
- **Pure enrichment.** Everything degrades to today's MVP behavior when no adapter is installed. Nothing the adapter touches is load-bearing.
- **Provider idiosyncrasy is quarantined** in one function (`normalize()`) and one orchestration step (`install()`). The hub stays provider-agnostic.
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
- **Native session-file ↔ store reconciliation** — the read-back/repair counterpart to push capture; natural home for backfilling usage/turns missed while the hub was down.
- **Cost/pricing tables** — `cost_usd` stored only if a provider hands it to us; agmux maintains no pricing table (an `insights` concern later).
- **Output/stream capture** — unchanged from MVP exclusions.

---

## 2. Architecture & the core/adapter boundary

`@agmux/adapters` splits into a **shared core** (agent-agnostic) and thin **per-provider adapter modules** (the only place provider knowledge lives). One new CLI surface (`agmux emit`) is the runtime callback target.

```
@agmux/adapters
  core/
    manifest.ts      # canonical vocabulary: hook-points + event kinds we want
    registry.ts      # (agent_kind) -> Adapter module lookup
    install.ts       # orchestrates install()/uninstall(); idempotent; writes ledger
    normalize.ts     # raw provider callback -> canonical AgmuxEvent[] pipeline
    capabilities.ts  # capability declaration + negotiation
    types.ts         # the Adapter interface (the "unified interface")
  adapters/
    claude/          # render manifest -> Claude plugin; map Claude hook payloads  (follow-on)
    codex/  gemini/  opencode/  pi/                                                 (follow-on)
```

### 2.1 The `Adapter` interface (the unified contract)

Every provider module implements:

| Member | Purpose |
|---|---|
| `agentKind: AgentKind` | which `agent_kind` this serves |
| `capabilities(ctx): CapabilityMap` | which hook-points it can fulfill *for the given install target* (see §6) — may differ per profile |
| `install(ctx): InstallRecord` | render the agmux manifest into the provider's native plugin format and wire it into the target profile's config dir; return an exact record of what changed |
| `uninstall(ctx, record): void` | exact reverse, driven by the recorded `InstallRecord` |
| `status(ctx): InstallStatus` | installed? version? config drift vs recorded state? |
| `normalize(point, raw): AgmuxEvent[]` | map one raw provider callback payload (for a given hook-point) into zero-or-more canonical events |
| `resumeArgs(native_session_id): string[]` | provider-specific flags to resume a native conversation (closes the MVP resume gap, §6.4) |

`ctx` (an `InstallContext`) carries the **resolved install target**: `{ agentKind, profile | null, configDir, env }` — produced by reusing the wrapper's existing profile resolver. The adapter knows *how* to install into a given config dir; the *which dir* comes from target resolution (§6.1).

### 2.2 Who calls what

- **Install time** (`agmux adapter install`, run once per target): core `install.ts` resolves the target, invokes the adapter's `install()`, and persists the returned `InstallRecord` — including the resolved `CapabilityMap` — to the ledger (§6.3). No event is emitted here (install is not tied to a `session_id`).
- **Runtime**: installed hooks fire *inside the agent* and shell out to **`agmux emit`** (§4), which runs the adapter's `normalize()` client-side, stamps identity, and POSTs canonical events to the existing hub `/ingest`.
- **The wrapper is untouched** except the one small resume thread-through (§6.4). It already injects `AGMUX_SESSION_ID`; the persistent plugin reads it at runtime. No per-launch adapter work — the perf-sensitive, fragile wrapper stays isolated per foundation §9.

### 2.3 Consequences

1. **Install is the only mutating, provider-specific orchestration**, and it's out of the hot path: run once, explicit, reversible.
2. **`normalize()` is the single quarantine for provider idiosyncrasy** — the exact surface per-provider subagents stress-test.
3. **The hub never imports adapter code** — it ingests already-canonical events.

---

## 3. Manifest vocabulary & event contract

The **manifest** is the agent-agnostic middle: the fixed set of hook-points agmux cares about. Each adapter declares which it can fulfill; each fulfilled hook-point produces one canonical **event kind** on `/ingest`. The hub already stores unknown kinds raw (MVP); v1 teaches the projection to *act* on these.

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

Every field nullable; an adapter fills what its provider exposes:

```
{ model?, input_tokens?, output_tokens?,
  cache_read_tokens?, cache_write_tokens?,
  cost_usd?, turn_id?, cumulative: boolean }
```

`cumulative` distinguishes a per-turn delta (`false`) from a session-to-date total (`true`) — providers report one or the other, and consumers must know which. `cost_usd` stored only if the provider hands it over (§1.4).

### 3.3 Envelope rules

- **Identity:** `session_id = AGMUX_SESSION_ID` on every event; unresolved -> dropped at the shim (§4), never guessed.
- **Versioning:** each new kind is `version: 1`, validated leniently (unknown -> stored raw), so a stale adapter never corrupts the log (foundation §6 schema-evolution principle).

### 3.4 Projection is the authority; adapters are best-effort

The projection treats `turn.*` / `input.*` as a small state machine over live statuses and **ignores illegal/duplicate transitions** (a second `turn.started`, any live transition on an `ended` row). Providers will not emit perfectly-paired events; the projection keeps status sane regardless. Full rules in §5.

---

## 4. The `agmux emit` callback path

`agmux emit` is the **universal inbound surface** — a new stateless `agmux` subcommand. Installed hooks shell out to it; it normalizes and POSTs to the existing hub `/ingest`. No new daemon.

### 4.1 Dumb hook, smart emit

The adapter's `install()` bakes the *dumbest possible* call into the provider's hook config — pass the raw provider payload through, tagged with origin and hook-point:

```
# example shape the adapter installs into the provider's hook config:
agmux emit --from=claude --point=turn.start     # raw provider JSON on stdin
```

`agmux emit` then:
1. resolves `agent_kind` from `--from`,
2. loads that adapter's `normalize(point, rawStdin)` -> zero-or-more canonical events,
3. stamps each with `session_id = $AGMUX_SESSION_ID` + envelope fields (`event_id` ULID, `ts`, `host`, `version`),
4. POSTs to `/ingest`.

**`normalize()` runs client-side, inside `emit`** — so the hub stays provider-agnostic and all idiosyncrasy stays in the adapter package.

### 4.2 Hot-path constraints (runs inside the agent)

1. **Never break the agent's hook.** `emit` *always* exits 0 — bad input, missing env, unreachable hub. A telemetry failure must never fail a user's tool call or block a turn.
2. **Never block.** Short timeout (<= the wrapper's, likely shorter); on timeout / network / 5xx, fall back to the queue and return immediately. Fire-and-forget.
3. **Drop, don't guess.** No `AGMUX_SESSION_ID` -> drop the event (debug-trace it), never send with an invented id.

### 4.3 Reliability — reuse, don't reinvent

`emit` writes to the **same per-session queue file** the wrapper already owns for write-through fallback: `~/.agmux/queue/<session_id>.jsonl`. The wrapper's existing flush loop drains it — an event emitted while the hub is briefly down is delivered on the next heartbeat flush, with zero new flush machinery. Append-only JSONL keeps concurrent wrapper+emit appends safe.

**Known edge (accepted, v1):** events emitted *after* the wrapper exits while the hub is down sit in the queue until the next session flushes that file. Acceptable; the deferred native-file reconciliation (§1.4) is the eventual backfill path.

### 4.4 Idempotency

Each event gets a fresh `event_id` (ULID); the store's `append` is already idempotent on `event_id`, so a flushed-*and*-delivered duplicate is a no-op.

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
- **A new `session_usage` projection table** (one row per `session_id`) maintains running totals: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `last_model`, `turn_count`. Upsert honors the payload's `cumulative` flag — `true` replaces totals (provider already summed), `false` adds the delta. Gives `agmux ls`/`inspect` instant per-session usage without scanning the log.

`session_usage` lives beside `sessions`, rebuildable by replaying the log like every other projection. The `sessions` table shape is unchanged (usage is a join when wanted) — keeps the hot row lean.

### 5.3 Migration

One additive migration adds `session_usage`. `native_session_id` and the `running`/`waiting` status values already exist from MVP. Nothing destructive.

---

## 6. Profile-aware install, capabilities, and resume

### 6.1 Install target is `(agent_kind, profile)`, not `agent_kind`

Profiles are first-class (foundation §10) and a profile can resolve to its **own native config dir** (own settings/hooks/skills). Therefore:

- Installing into `claude-work`'s config dir leaves bare `claude` — and every other claude profile — untouched and reported **uninstalled**.
- The **bare `agent_kind`** (ad-hoc `agmux run claude`, no profile) is its own install target against the provider's default config dir, independently installable/uninstallable.
- `install(ctx)` is parameterized by the resolved profile: `ctx.configDir` / `ctx.env` come from the wrapper's existing profile resolver; `install()` renders the plugin into *that* location.

### 6.2 Capability negotiation

Each adapter declares, per hook-point and **per target**, whether it can fulfill it:

```
capabilities = {
  "session.linked": "yes",
  "turn":           "yes",      // turn.started/ended
  "input":          "partial",  // permission gates yes, free-text prompts no
  "usage":          "yes",
  "tool":           "no",
}
```

Capabilities can differ across profiles of the same kind (a profile's config may disable a hook), so they're resolved **per target at install time** and stored in the ledger (§6.3), not assumed uniform per `agent_kind`. At **session start**, the installed hook emits a `session.adapter_attached` event carrying that session's `{ agent_kind, profile, adapter_version, capabilities }` (stamped with the session's `AGMUX_SESSION_ID` like every other event). The projection associates those capabilities with the session, so consumers can answer "is `running`/`waiting` trustworthy for *this* session, or only ever `idle`?" Capability is data, not docs.

### 6.3 Install-state ledger

`install()` returns an `InstallRecord` (files written, config keys added, plugin version); core persists it per target:

```
~/.agmux/adapters/<agent_kind>[@<profile>].json
```

So `status` (drift detection), `uninstall` (exact reverse), and future re-render on agmux upgrade are all per-target-exact.

### 6.4 Resume integration (closes the MVP gap)

Once `native_session_id` is populated via `session.linked`, `agmux attach` on an `ended`/`lost` session calls the adapter's `resumeArgs(native_session_id)` to relaunch with the provider's native resume flag — restoring the *actual* conversation, not a fresh one (the MVP spec named this "the first job of adapters"). This is the **one wrapper touch-point**: thread `resumeArgs` into the relaunch path. Small, isolated, and separate from the adapter package itself.

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
| `@agmux/protocol` | new event kinds + payload types + lenient validators for §3.1–3.2; capability + usage types |
| `@agmux/store` | `session_usage` table + migration; projection handlers + status state machine + lost-sweep precedence (§5) |
| `@agmux/hub` | none structural — ingests already-canonical events (validators extended via protocol) |
| `@agmux/adapters` | **new package** — core (`types/manifest/registry/install/normalize/capabilities`); no concrete provider in v1 |
| `@agmux/cli` | `agmux adapter` verb group + `agmux emit`; resume thread-through in `attach` |
| `@agmux/wrapper` | one touch-point: accept `resumeArgs` on relaunch (§6.4) |

---

## 9. Validation plan (post-acceptance)

Per the chosen approach, after this abstraction is accepted, dispatch **one subagent per provider** (Claude Code, Codex, Gemini/Antigravity, opencode, pi) to challenge the abstraction against that provider's real plugin/hook/event architecture and report: which hook-points map cleanly, which are `partial`/`no`, what the native plugin install looks like, how `normalize()` would parse its payloads, and any assumption this spec makes that the provider breaks. Findings refine this spec before any provider implementation spec is written.

---

## 10. Open questions (resolved here, recorded for traceability)

- **Invasiveness** — adapters install into the agent's *own* plugin system (idiomatic), not external observation; install-once persistent. Resolved.
- **Transport** — `agmux emit` shim (universal, v1). MCP deferred as additive second transport. Resolved.
- **Authoring shape** — hybrid: shared core + thin per-provider code modules. Resolved.
- **Install granularity** — per `(agent_kind, profile)` target. Resolved.
