# agmux — Native-First Session Tracking Design

**Date:** 2026-06-05
**Status:** Design (spec). Two-stage implementation, two separate plans.
**Supersedes:** the "wrapper-primary" stance of [`docs/agmux-foundation.md`](../../agmux-foundation.md) §4 (capture model) and §5 (identity). Builds on the adapter framework ([`2026-05-29-adapters-framework-design.md`](2026-05-29-adapters-framework-design.md)) and the Claude adapter ([`2026-05-29-adapter-claude-design.md`](2026-05-29-adapter-claude-design.md)), both landed.

## 1. Motivation

The MVP made the PTY **wrapper** the source of truth: it minted the canonical `session_id`, injected it via `AGMUX_SESSION_ID`, and emitted lifecycle events from outside the agent. Adapters were enrichment layered on top.

Now that every targeted provider ships a native extension surface (hooks/plugins) and the Claude adapter already drives status, usage, identity, and resume from *inside* the agent, the wrapper is mostly redundant — and its env-injected identity is actively fragile. The summarizer bug (a `SessionEnd` hook spawning `claude -p`, inheriting `AGMUX_SESSION_ID`, and re-linking its own native id into the dead session) is the canonical symptom: **identity that is env-inherited leaks into nested agent runs.**

This spec inverts the model. The agent's own hooks become the primary source of truth: a session **self-registers** with its native identity, and the hub mints-or-links the canonical session. The wrapper is demoted to an opt-in specialist (`--wrapped`) for PTY/heartbeat/future-output-capture and for agent kinds that have no registering adapter. Identity stops being env-inherited: every hook event carries its own native identity from hook stdin.

### Goals

1. **Native registration**: a session is created from its own hooks; no wrapper required.
2. **Ambient tracking**: any session in an adapter-installed config dir is tracked — `agmux ls`/`attach`/`inspect` work on sessions started directly with `claude`, not just `agmux run`.
3. **Leak-proof identity**: per-event identity comes from hook stdin, never inherited env. The summarizer-class bug becomes structurally impossible.
4. **Preserve tmux control**: `agmux run` keeps profile resolution + placement (the substrate for future agent-spawns-subagent-into-a-pane).
5. **Cross-kind lineage, resolver-only**: canonical→canonical `parent_session_id` edges, resolvable across agent kinds; spawn ergonomics deferred.

### Non-goals (this spec)

- The subagent-spawn feature itself (verb, env-probing UX, child placement) — only the lineage *resolver* is built.
- Output/stream capture, MCP transport, continuous source modes — unchanged deferrals.
- Removing the wrapper — it remains for `--wrapped` and adapter-less kinds.

---

## 2. Identity model (the inversion)

### 2.1 Two ways an event names its session

The event envelope today requires `session_id`. It becomes **one of two identity forms**:

- **Canonical** — `session_id` present (wrapper-minted, or a resolved/known session). Today's form.
- **Native** — `session_id` absent/null, `identity: { agent_kind, native_session_id }` present. The hub resolves it to a canonical id at ingest.

Exactly one must be present; an envelope with neither is rejected (400) as today.

**Resolution happens at the hub, at ingest.** This keeps `emit` stateless (it never needs to know the canonical id), keeps the offline queue correct (queued events carry native identity; the startup drain resolves them against the then-current mapping), and centralizes the one safety-critical operation — minting canonical ids — in a single place.

### 2.2 `session.registered` — the new lifecycle root

A new event kind, emitted by the adapter's session-start hook:

```
session.registered {
  native_session_id: string,
  pid: number | null,            // agent pid (shim reads its process tree / $PPID chain)
  cwd: string | null,
  tmux_session / tmux_window / tmux_pane: string | null,  // from inherited $TMUX_PANE
  profile: string | null,        // from AGMUX_PROFILE env hint when agmux-launched
  agent_version: string | null,
  parent: { agent_kind, native_session_id } | null,       // lineage hint (§5)
}
```

It carries native identity (the envelope's `identity` block). It is the native analogue of `session.started`.

### 2.3 Resolution rules (hub, in order)

Given an incoming event with native identity `(K, N)` on `host H`:

1. **Known** — a session mapped to `(K, N, H)` exists → that session. **If it is `ended`, registration reopens it** (status → `idle`; appends `session.resumed`). This is ambient resume detection: `claude --resume <N>` re-registers under the same `N` and lands back in the same agmux session, with **no env threading**.
2. **Claim** (wrapped bridge) — the envelope also carries `claim_session_id` (from `AGMUX_SESSION_ID`, set only by the wrapper/launcher) AND that session is live, same `agent_kind`, and its `native_session_id` is still null → adopt: set its `native_session_id = N`. A *stale* inherited env (the summarizer) fails this rule because the target session already has a different native id, and falls through.
3. **Pid rotation** — a live session with the same `(host, pid, agent_kind)` exists whose native id differs → the native id rotated in-process (`/clear`, compaction) → update that session's `native_session_id = N`. Preserves pane/session continuity across `/clear`. (Supersedes the Claude adapter's `clear|compact` re-link hack, which can be simplified to plain re-registration.)
4. **Mint** — none of the above → create a fresh canonical session (UUIDv7, `origin: "native"`), synthesizing the row from the `session.registered` payload (pid, cwd, tmux coords, profile, agent_kind).

Non-registration events (`turn.*`, `usage.reported`, `input.*`, `tool.used`, `prompt.sent`) carrying native identity resolve by rule 1 only; if unknown, they are dropped (debug-traced) — a telemetry event for an unregistered session is noise, never a reason to mint.

### 2.4 Identity is never env-inherited again

Every hook emits its **own** native id from its hook stdin (`CLAUDE_CODE_SESSION_ID` is also present per-event on stdin as `session_id`). The summarizer's `claude -p` therefore emits *its own* native id, resolves to *its own* (minted) session, and cannot touch the parent. The Stage-2 cleanup removes the now-obsolete env nesting guard (`normalize` no longer needs `env.CLAUDE_CODE_SESSION_ID` cross-checks) and supersedes the projection freeze for native resumes (rule 1 reopen replaces it; freeze is retained only as defense for the wrapped flow).

---

## 3. Liveness (hybrid)

Two origins, two liveness signals, composed in the read-time status computation:

- **`origin: "wrapper"`** — real heartbeats (winsize, explicit `pane_closed`), exactly as today. `computeEffectiveStatus` applies the existing `LOST_THRESHOLD_MS` heartbeat-staleness rule.
- **`origin: "native"`** — no heartbeats. The hub runs a **pid sweep** every `HEARTBEAT_INTERVAL_MS` over live native rows whose `host` matches the hub's host: `kill -0 pid`. A dead pid appends a canonical **`session.lost`** event (append-only, replayable observation), which the projection maps to stored status `lost`. Heartbeat-staleness does **not** apply to native rows (they have none).

`computeEffectiveStatus` becomes origin-aware. Pid reuse (a dead agent's pid recycled by an unrelated process before the sweep notices) is an accepted v1 edge; `pid + start_ts` disambiguation is reserved.

Cross-host native sessions (a registration whose `host` ≠ the hub's host) are never pid-swept — they stay in their last event-driven status. Acceptable: agmux is localhost-first; remote liveness is out of scope.

---

## 4. Launcher & wrapper

### 4.1 Stage 1 — additive, nothing changes in `run`

Wrapped and native sessions coexist. `agmux run` still wraps (today's behavior). When a wrapped Claude session's hooks also fire `session.registered`, the **claim** rule (§2.3 rule 2) bridges the hook events onto the wrapper-minted session — one session, not two. Everything in Stage 1 is purely additive; no existing path regresses.

### 4.2 Stage 2 — `run` defaults to direct exec

`agmux run`:
- **Keeps** profile resolution and tmux placement (`packages/cli/src/tmux-place.ts`, `run.ts` placement logic — untouched). Placement is CLI-side and independent of the PTY wrapper, so the future subagent-into-a-pane substrate is preserved.
- **Direct-execs** the agent (no PTY interposition, no pre-minted canonical id) with env hints `AGMUX_BIN` (so hooks find the emit shim) and `AGMUX_PROFILE` (so registration records the profile). Identity comes from the agent's own registration.
- `--wrapped` opts back into the PTY wrapper for heartbeats, exit codes, `pane_closed`, and future output capture.
- **Auto-wrap exception**: for an agent kind with **no registering adapter** (codex until its adapter lands; unknown kinds), `run` automatically wraps — otherwise a direct exec would emit nothing and be invisible. Determined by the registry: adapter present and declaring a `session.registered` source → direct exec; else wrap.

### 4.3 `attach`

- **Live** → tmux switch using the session's registered coords. Now works for ambient sessions too (coords captured at registration from `$TMUX_PANE`), which the wrapper-first model could never see.
- **Dead/lost** → relaunch via the adapter `resumePlan` argv, placed via the same tmux placement code. The resumed agent **re-registers** under rule 1 (reopen) → same canonical session, no env threading. The turn-count guard (don't resume a turn-less session) stays.

---

## 5. Lineage (resolver-only)

Lineage is canonical→canonical and lives entirely in `SessionRow.parent_session_id` (already in the schema). The native index is **not** an alternative identity — it is the *resolver* that maps a native pointer to a canonical id.

- `session.registered.parent` carries the parent's **native** identity `{ agent_kind, native_session_id }` (a child cannot know the parent's canonical id — no process ever saw it).
- At registration, if `parent` is present, the hub resolves it via the `(agent_kind, native_session_id, host)` index → the parent's canonical id → writes `child.parent_session_id`. Cross-kind works because the hint names the parent's kind explicitly; the child's kind is irrelevant to the lookup.
- Unresolvable parent (not yet registered, or cross-host) → leave `parent_session_id` null, debug-trace; **never fail the registration**.

**Why this is leak-safe:** a lineage hint is a strictly weaker claim than identity — "spawned by X," not "you are X." Accidental inheritance yields at worst a spurious parent *edge*, never stolen identity or polluted telemetry — a different blast radius entirely from the summarizer bug.

**New adapter member** (enables the deferred spawn feature to name the parent): `nativeIdFromEnv(env: Record<string,string|undefined>): string | null` — reads the agent's *own* native id from its tool/hook environment (claude: `CLAUDE_CODE_SESSION_ID`). The future spawn path probes registered adapters against the caller's env to identify the parent; only the resolver and this member are built now.

**Deferred to the spawn feature**: the spawn verb, adapter env-probing UX, child pane placement. Lineage is fully testable now by passing an explicit `parent` hint to `session.registered`.

---

## 6. Contract deltas

| Package | Change |
|---|---|
| `@agmux/protocol` | Envelope: `session_id` optional when `identity: { agent_kind, native_session_id }` present (exactly-one-of validation); `claim_session_id?` field. New kinds `session.registered`, `session.lost` + payloads. `SessionRow.origin: "wrapper" \| "native"`. Adapter type: `nativeIdFromEnv?(env)`; sources may declare a `session.registered` capability. |
| `@agmux/store` | v3 migration: `sessions.origin`; unique index `idx_native_identity` on `(agent_kind, native_session_id, host)`. Projection: register/reopen/rotate/mint handlers, `session.lost` handler. Origin-aware `lost.ts`. Parent-hint resolution writing `parent_session_id`. |
| `@agmux/hub` | Ingest-time identity resolution (the §2.3 rules); native pid-sweep timer emitting `session.lost`. |
| `@agmux/adapters` (claude) | Plugin v1.2.0: SessionStart emits `session.registered` (with pid/cwd/tmux/profile); all hooks switch to native-identity emission (drop env-id reliance). `nativeIdFromEnv` reads `CLAUDE_CODE_SESSION_ID`. The `clear\|compact` re-link reduces to plain re-registration (rule 3). |
| `@agmux/cli` | Stage 2: `run` direct-exec default + `--wrapped` + auto-wrap-when-no-adapter; `emit` sets the envelope identity block from stdin and passes `claim_session_id` when `AGMUX_SESSION_ID` is set; `ls` already shows origin-relevant columns. |
| `@agmux/wrapper` | Stage 1: untouched. Stage 2: invoked only under `--wrapped`/auto-wrap; still sets `claim_session_id` for the bridge. |

---

## 7. Staging

**Stage 1 (hub-side, additive — its own plan):** protocol identity forms + new kinds; v3 migration; ingest resolution rules; pid-sweep liveness; Claude plugin emits `session.registered` and native-identity events; lineage resolver. `agmux run` still wraps; claim rule bridges. Independently shippable and testable; daily workflow cannot regress because the wrapper path is unchanged. Dogfood until native registration is trusted.

**Stage 2 (launcher flip — its own plan, after Stage 1 is proven):** `run` defaults to direct exec; `--wrapped` + auto-wrap exception; remove the env nesting guard; demote the projection freeze to wrapped-only. Small CLI-centric change once Stage 1 is solid.

---

## 8. Risks & open items (for the implementation plans)

- **Pid capture from a hook** — the emit shim must read the agent pid reliably (parent-process chain; `$PPID` points at the shim, not the agent). Verify the hop count per provider; store null if unobtainable (degrades to event-staleness for that row).
- **Claim-rule race** — a wrapped session whose hook registers *before* the wrapper's `session.started` lands. Mitigation: the wrapper posts `session.started` before exec; if a native registration arrives first it mints, and the later `started` with `claim_session_id` must merge rather than duplicate. The plan must specify the merge/ordering precisely (or have the wrapper pre-register).
- **Pid reuse** under native liveness (§3) — accepted v1; document.
- **Cross-host native rows** — never pid-swept; document the limitation.
- **Foundation doc** — §4/§5 must be annotated as superseded by this spec.
