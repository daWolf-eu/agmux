# Native-First Stage 1 (hub-side identity resolution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a session creatable from its own hooks: a native `session.registered` event carries the agent's own native id, the hub resolves it to a canonical session (mint / reopen / claim / rotate), pid-sweep liveness marks dead native sessions `lost`, and a parent hint resolves cross-kind lineage — all additive, with `agmux run` still wrapping.

**Architecture:** A new **wire envelope** (`IngestEnvelope`) may name its session two ways — `session_id` (canonical, today's form) or `identity:{agent_kind,native_session_id}` (native). The hub resolves the native form to a canonical id **at ingest** using four ordered rules, then appends a normal storage `EventEnvelope` (unchanged, `session_id` always present). The store gains an `origin` column (`wrapper`/`native`), a unique resolver index on `(agent_kind, native_session_id, host)`, projection handlers for `session.registered`/`session.lost`, and origin-aware liveness. The Claude plugin (v1.2.0) emits `session.registered` from `SessionStart`; `emit` builds the identity block from the agent's own env, never threading the canonical id.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, `bun test`. Monorepo packages: `@agmux/protocol`, `@agmux/store`, `@agmux/hub`, `@agmux/adapters`, `@agmux/cli`.

**Spec:** [`docs/superpowers/specs/2026-06-05-native-first-design.md`](../specs/2026-06-05-native-first-design.md) — this plan implements **Stage 1** (§7). Stage 2 (launcher flip) is a separate plan.

---

## Key design decisions locked here (read before starting)

1. **Storage `EventEnvelope` is unchanged.** `session_id: string` stays required. The two-identity-forms relaxation lives only in a new wire type `IngestEnvelope`. The hub resolves `IngestEnvelope → EventEnvelope` before `store.append`. This keeps the blast radius tiny: the projection, queries, and store stay typed on a concrete `session_id`.

2. **Resolution is read-only id-selection; the projection does the writes.** `resolveIngest()` reads the resolver index and live sessions to *pick* the canonical `session_id`, then stamps it. The projection's `applyRegistered()` — keyed by that resolved id — does the actual mint/reopen/claim/rotate by inspecting the existing row. The projection never sees which rule fired; it branches on row state.

3. **Claim rule requires the target to already exist and be live** (spec §2.3 rule 2 verbatim). In the wrapped flow the wrapper posts `session.started` *before* it execs the agent, and the agent's `SessionStart` hook cannot fire until after exec — so the wrapper session is in the DB before the native registration arrives. The reverse race (registration first) falls through to **mint**, producing a transient duplicate native row that gets pid-swept to `lost`; this is the accepted v1 edge documented in spec §8. We do **not** change `applyStarted` (it keeps `ON CONFLICT DO NOTHING`).

4. **`session.linked` emission is replaced by `session.registered`** in the Claude plugin v1.2.0. The `session.linked` *kind* and its projection stay in the protocol (other adapters / back-compat), but Claude stops emitting it — `session.registered` does its job better (it also mints/claims). Reinstalling the plugin (`agmux install claude`) is the migration step; no running session regresses.

5. **`pid` capture uses the hook shell's `$PPID`.** Claude runs each hook command in a shell whose parent process is the `claude` agent, so `$PPID` inside that shell is the agent pid. The plugin passes it as `AGMUX_AGENT_PID=$PPID` on the registered hook; `emit` forwards `input.env`, and the adapter reads `env.AGMUX_AGENT_PID`. If absent/non-numeric, store `null` (degrades that row to never-pid-swept). tmux session/window capture is deferred to Stage 2 (the attach flip); Stage 1 captures only `tmux_pane` from `$TMUX_PANE`.

6. **The nesting guard stays** (Stage 1). Its removal is Stage 2 (spec §2.4). It only drops events when `env.CLAUDE_CODE_SESSION_ID !== raw.session_id`; in a normal (non-nested) run they are equal, so registration is unaffected.

---

## File structure (what changes, and why)

**`@agmux/protocol`**
- `src/events.ts` — add `NativeIdentity`, `IngestEnvelope`, `SessionRegisteredPayload`, `SessionLostPayload`, their typed-event aliases, extend `KnownEvent`, add `"session.registered"` to `EVENT_KINDS_ADAPTER`.
- `src/session.ts` — add `origin: "wrapper" | "native"` to `SessionRow` and a `SessionOrigin` type.
- `src/validators.ts` — add `validateIngestEnvelope` (exactly-one-of) and `validateKnownPayload` cases for the two new kinds.
- `src/ids.ts` *(new)* — `mintSessionId()` (UUIDv7), shared by hub/store.
- `src/index.ts` — export the new module.

**`@agmux/store`**
- `src/schema.ts` — `SCHEMA_V3` (origin column + partial unique resolver index).
- `src/migrations.ts` — register migration 3.
- `src/project.ts` — `applyRegistered`, `applyLost`, dispatch wiring.
- `src/resolve.ts` *(new)* — `resolveIngest()` (the four rules) + `IngestEnvelopeLike`/`ResolveResult`.
- `src/queries.ts` — `decodeRow` reads `origin`; `listLiveNativeSessions()`.
- `src/lost.ts` — `computeEffectiveStatus` becomes origin-aware.
- `src/index.ts` — `Store.resolveAndAppend()`, `Store.listLiveNativeSessions()`, re-export resolve.

**`@agmux/hub`**
- `src/server.ts` — `/ingest` uses `validateIngestEnvelope` + `store.resolveAndAppend`.
- `src/liveness.ts` *(new)* — `buildLostEvent`, `sweepNativeLiveness`, `startNativeLivenessSweep`.
- `src/drain.ts` — route queued events through `store.resolveAndAppend`.
- `bin/agmux-hub.ts` — start/stop the sweep timer.
- `src/index.ts` — export liveness.

**`@agmux/adapters`**
- `src/core/types.ts` — add `"session.registered"` to `MANIFEST_POINTS`; add optional `nativeIdFromEnv?` to `Adapter`.
- `src/core/normalize.ts` — `stampIngestEvents()`.
- `src/adapters/claude/caps.ts` — register the `session.registered` source point + capability.
- `src/adapters/claude/normalize.ts` — `session.registered` case + `cwd` in stdin type.
- `src/adapters/claude/index.ts` — wire `nativeIdFromEnv`.
- `src/adapters/claude/plugin-files.ts` — v1.2.0 hook wiring.
- `tests/fixtures/fake-adapter.ts` — add `nativeIdFromEnv` for emit native-path tests.

**`@agmux/cli`**
- `src/emit.ts` — native-identity emission flow + queue keying.

**Docs**
- `docs/agmux-foundation.md` — annotate §4/§5 as superseded.

---

## Task 1: Protocol — wire envelope + new event types

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Modify: `packages/protocol/src/session.ts`
- Test: `packages/protocol/tests/events-types.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/tests/events-types.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { EVENT_KINDS_ADAPTER } from "../src/events.ts";
import type {
  IngestEnvelope, NativeIdentity, SessionRegisteredPayload, SessionLostPayload,
} from "../src/events.ts";
import type { SessionRow, SessionOrigin } from "../src/session.ts";

test("session.registered is an adapter event kind", () => {
  expect(EVENT_KINDS_ADAPTER).toContain("session.registered");
});

test("IngestEnvelope accepts the native identity form", () => {
  const id: NativeIdentity = { agent_kind: "claude", native_session_id: "n-1" };
  const ev: IngestEnvelope<SessionRegisteredPayload> = {
    event_id: "e1", ts: "2026-06-08T00:00:00.000Z", kind: "session.registered",
    version: 1, host: "h", identity: id, claim_session_id: null,
    payload: { native_session_id: "n-1", agent_kind: "claude", pid: 4242, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: "%1", profile: null,
      agent_version: null, parent: null },
  };
  expect(ev.identity?.native_session_id).toBe("n-1");
});

test("IngestEnvelope accepts the canonical form (session_id)", () => {
  const ev: IngestEnvelope = {
    event_id: "e2", ts: "2026-06-08T00:00:00.000Z", kind: "turn.started",
    version: 1, host: "h", session_id: "sid-1", payload: {},
  };
  expect(ev.session_id).toBe("sid-1");
});

test("SessionLostPayload + SessionRow.origin compile", () => {
  const lost: SessionLostPayload = { reason: "pid_dead" };
  const origin: SessionOrigin = "native";
  const row = { origin } as Pick<SessionRow, "origin">;
  expect(lost.reason).toBe("pid_dead");
  expect(row.origin).toBe("native");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bun test tests/events-types.test.ts`
Expected: FAIL — `IngestEnvelope`, `NativeIdentity`, `SessionRegisteredPayload`, `SessionLostPayload`, `SessionOrigin` not exported; `EVENT_KINDS_ADAPTER` does not contain `session.registered`.

- [ ] **Step 3: Add the origin type to `session.ts`**

In `packages/protocol/src/session.ts`, after the `AgentKind` line (line 7), add:

```typescript
export type SessionOrigin = "wrapper" | "native";
```

Then add `origin` to the `SessionRow` interface (after `status: SessionStatus;`, before the `turn_count` comment block):

```typescript
  status: SessionStatus;
  // How the session row was created: "wrapper" = PTY-wrapper-minted (heartbeat
  // liveness); "native" = self-registered from the agent's own hooks (pid-sweep
  // liveness). Drives origin-aware status computation. Defaults to "wrapper" for
  // rows that predate the native-first migration.
  origin: SessionOrigin;
```

- [ ] **Step 4: Add the new kind to the adapter-kinds array in `events.ts`**

In `packages/protocol/src/events.ts`, add `"session.registered"` to `EVENT_KINDS_ADAPTER` (insert as the first entry so it reads as the native lifecycle root):

```typescript
export const EVENT_KINDS_ADAPTER = [
  "session.registered",
  "session.linked",
  "turn.started",
  "turn.ended",
  "input.required",
  "input.received",
  "usage.reported",
  "tool.used",
  "prompt.sent",
  "session.adapter_attached",
] as const;
export type AdapterEventKind = (typeof EVENT_KINDS_ADAPTER)[number];
```

- [ ] **Step 5: Add the wire envelope + payloads to `events.ts`**

In `packages/protocol/src/events.ts`, immediately after the `EventEnvelope` interface (ends at line 34), add:

```typescript
// Native identity: how a hook-emitted event names its session when no canonical
// id exists yet. The hub resolves (agent_kind, native_session_id, host) → a
// canonical session at ingest (spec §2).
export interface NativeIdentity {
  agent_kind: AgentKind;
  native_session_id: string;
}

// The wire form accepted by POST /ingest. EXACTLY ONE of `session_id` (canonical)
// or `identity` (native) must be present (validateIngestEnvelope enforces it).
// `claim_session_id` is the wrapper bridge hint (from AGMUX_SESSION_ID), set only
// by the wrapper/launcher. The hub rewrites this into a storage EventEnvelope.
export interface IngestEnvelope<P = unknown> {
  event_id: string;
  ts: string;
  kind: string;
  version: number;
  host: string;
  payload: P;
  dedup_key?: string | null;
  session_id?: string | null;
  identity?: NativeIdentity | null;
  claim_session_id?: string | null;
}
```

Then add the two new payload types alongside the other payloads (after `SessionLinkedPayload`, around line 71):

```typescript
// The native lifecycle root (spec §2.2). Carries the session's own native id plus
// the row-synthesis fields used when the hub mints. `parent` is a lineage hint in
// the parent's native identity (spec §5), resolved to parent_session_id at ingest.
export interface SessionRegisteredPayload {
  native_session_id: string;
  agent_kind: AgentKind;
  pid: number | null;
  cwd: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  profile: string | null;
  agent_version: string | null;
  parent: NativeIdentity | null;
}

// Hub-emitted (pid-sweep) observation that a native session's pid is gone (spec §3).
export interface SessionLostPayload {
  reason: "pid_dead";
}
```

- [ ] **Step 6: Add typed-event aliases and extend `KnownEvent`**

In `packages/protocol/src/events.ts`, add to the typed-event block (after `SessionLinkedEvent`, line 114):

```typescript
export type SessionRegisteredEvent = EventEnvelope<SessionRegisteredPayload> & { kind: "session.registered" };
export type SessionLostEvent = EventEnvelope<SessionLostPayload> & { kind: "session.lost" };
```

Add both to the `KnownEvent` union (after `SessionLinkedEvent`):

```typescript
  | SessionLinkedEvent
  | SessionRegisteredEvent
  | SessionLostEvent
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd packages/protocol && bun test tests/events-types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/session.ts packages/protocol/tests/events-types.test.ts
git commit -m "protocol: native identity wire envelope + session.registered/lost types"
```

---

## Task 2: Protocol — ingest validator + new payload validation

**Files:**
- Modify: `packages/protocol/src/validators.ts`
- Test: `packages/protocol/tests/validators.test.ts:1` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/tests/validators.test.ts`:

```typescript
import { validateIngestEnvelope } from "../src/validators.ts";

const baseWire = { event_id: "e1", ts: "2026-06-08T00:00:00.000Z", kind: "turn.started", version: 1, host: "h", payload: {} };

test("validateIngestEnvelope accepts the canonical form", () => {
  expect(validateIngestEnvelope({ ...baseWire, session_id: "sid-1" })).toEqual({ ok: true });
});

test("validateIngestEnvelope accepts the native form", () => {
  const r = validateIngestEnvelope({ ...baseWire, identity: { agent_kind: "claude", native_session_id: "n-1" } });
  expect(r).toEqual({ ok: true });
});

test("validateIngestEnvelope rejects BOTH forms present", () => {
  const r = validateIngestEnvelope({ ...baseWire, session_id: "sid-1", identity: { agent_kind: "claude", native_session_id: "n-1" } });
  expect(r.ok).toBe(false);
});

test("validateIngestEnvelope rejects NEITHER form present", () => {
  const r = validateIngestEnvelope(baseWire);
  expect(r.ok).toBe(false);
});

test("validateIngestEnvelope rejects a malformed identity", () => {
  const r = validateIngestEnvelope({ ...baseWire, identity: { agent_kind: "claude" } });
  expect(r.ok).toBe(false);
});

test("validateKnownPayload('session.registered') requires native_session_id + agent_kind", () => {
  expect(validateKnownPayload("session.registered", { native_session_id: "n-1", agent_kind: "claude" }).ok).toBe(true);
  expect(validateKnownPayload("session.registered", { native_session_id: "", agent_kind: "claude" }).ok).toBe(false);
  expect(validateKnownPayload("session.registered", { native_session_id: "n-1", agent_kind: "nope" }).ok).toBe(false);
});

test("validateKnownPayload('session.lost') accepts the pid_dead reason", () => {
  expect(validateKnownPayload("session.lost", { reason: "pid_dead" }).ok).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bun test tests/validators.test.ts`
Expected: FAIL — `validateIngestEnvelope` not exported; `validateKnownPayload` returns `{ok:true}` (default branch) for the two new kinds instead of validating.

- [ ] **Step 3: Add `validateIngestEnvelope`**

In `packages/protocol/src/validators.ts`, after `validateEnvelope` (ends line 26), add:

```typescript
// Wire-envelope validation for POST /ingest (spec §2.1). Like validateEnvelope but
// session_id is replaced by an exactly-one-of: a non-empty session_id (canonical)
// XOR an identity{agent_kind, native_session_id} (native). claim_session_id, when
// present, is just an optional hint and is not validated here.
export function validateIngestEnvelope(v: unknown): ValidationResult {
  if (!isPlainObject(v)) return { ok: false, error: "envelope: not an object" };
  for (const k of ["event_id", "ts", "kind", "host"] as const) {
    if (!isStringNonEmpty(v[k])) return { ok: false, error: `envelope: ${k} missing or not non-empty string` };
  }
  if (!isInt(v.version)) return { ok: false, error: "envelope: version missing or not integer" };
  if (!("payload" in v)) return { ok: false, error: "envelope: payload missing" };

  const hasCanonical = isStringNonEmpty(v.session_id);
  const id = v.identity;
  const hasNative = isPlainObject(id) && isStringNonEmpty(id.agent_kind) && isStringNonEmpty(id.native_session_id);
  if (id != null && !hasNative) return { ok: false, error: "envelope: identity must have non-empty agent_kind and native_session_id" };
  if (hasCanonical && hasNative) return { ok: false, error: "envelope: session_id and identity are mutually exclusive" };
  if (!hasCanonical && !hasNative) return { ok: false, error: "envelope: one of session_id or identity{agent_kind,native_session_id} required" };
  return { ok: true };
}
```

- [ ] **Step 4: Add the two `validateKnownPayload` cases**

In `packages/protocol/src/validators.ts`, inside the `switch (kind)` of `validateKnownPayload`, add these cases before the `default:` (line 105). Reuse the existing `payload` local already in scope:

```typescript
    case "session.registered": {
      const p = payload;
      if (!isStringNonEmpty(p.native_session_id))
        return { ok: false, error: "session.registered: native_session_id missing" };
      if (p.agent_kind !== "claude" && p.agent_kind !== "codex")
        return { ok: false, error: "session.registered: agent_kind invalid" };
      return { ok: true };
    }
    case "session.lost": {
      if (payload.reason !== "pid_dead")
        return { ok: false, error: "session.lost: reason must be pid_dead" };
      return { ok: true };
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/protocol && bun test tests/validators.test.ts`
Expected: PASS (existing + 7 new tests).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/validators.ts packages/protocol/tests/validators.test.ts
git commit -m "protocol: validateIngestEnvelope + session.registered/lost payload validation"
```

---

## Task 3: Protocol — shared `mintSessionId`

**Files:**
- Create: `packages/protocol/src/ids.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/tests/ids.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/tests/ids.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { mintSessionId } from "../src/ids.ts";

test("mintSessionId returns a v7 UUID string, unique per call", () => {
  const a = mintSessionId();
  const b = mintSessionId();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bun test tests/ids.test.ts`
Expected: FAIL — `Cannot find module "../src/ids.ts"`.

- [ ] **Step 3: Create the module**

Create `packages/protocol/src/ids.ts`:

```typescript
// Canonical session ids are UUIDv7 (time-ordered). Minted by the wrapper for
// wrapped sessions and by the hub when a native registration has no existing
// session to resolve to (spec §2.3 rule 4). Single source so both paths agree.
export function mintSessionId(): string {
  return Bun.randomUUIDv7();
}
```

- [ ] **Step 4: Export it**

In `packages/protocol/src/index.ts`, add:

```typescript
export * from "./ids.ts";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/protocol && bun test tests/ids.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/ids.ts packages/protocol/src/index.ts packages/protocol/tests/ids.test.ts
git commit -m "protocol: shared mintSessionId (UUIDv7) for native mint"
```

---

## Task 4: Store — v3 migration (origin column + resolver index)

**Files:**
- Modify: `packages/store/src/schema.ts`
- Modify: `packages/store/src/migrations.ts`
- Test: `packages/store/tests/migrations.test.ts:1` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/store/tests/migrations.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";

test("migration v3 adds sessions.origin defaulting to 'wrapper'", () => {
  const db = new Database(":memory:");
  const { to } = runMigrations(db);
  expect(to).toBe(3);
  const cols = db.query<{ name: string; dflt_value: string | null }, []>(`PRAGMA table_info(sessions)`).all();
  const origin = cols.find((c) => c.name === "origin");
  expect(origin).toBeDefined();
  expect(String(origin!.dflt_value)).toContain("wrapper");
});

test("migration v3 creates the native-identity resolver index", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const idx = db.query<{ name: string }, []>(`PRAGMA index_list(sessions)`).all();
  expect(idx.map((i) => i.name)).toContain("idx_native_identity");
});

test("resolver index allows many NULL native ids but rejects a duplicate (kind,native,host)", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const ins = (sid: string, nat: string | null) => db.query(`
    INSERT INTO sessions (session_id, agent_kind, profile, native_session_id, command, args_json, env_json, cwd, host, start_ts, status, origin)
    VALUES (?, 'claude', NULL, ?, 'c', '[]', '{}', '/tmp', 'h', '2026-06-08T00:00:00.000Z', 'idle', 'native')
  `).run(sid, nat);
  ins("s1", null); ins("s2", null);            // two NULLs: fine
  ins("s3", "n-1");
  expect(() => ins("s4", "n-1")).toThrow();     // duplicate (claude, n-1, h): rejected
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && bun test tests/migrations.test.ts`
Expected: FAIL — `to` is `2`; `origin` column missing; `idx_native_identity` absent.

- [ ] **Step 3: Add `SCHEMA_V3`**

In `packages/store/src/schema.ts`, after `SCHEMA_V2` (ends line 68), add:

```typescript
export const SCHEMA_V3 = `
ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'wrapper';

-- The native-identity resolver (spec §2.3 / §5). Partial unique index: the many
-- wrapper rows with a NULL native id never collide, but a non-null
-- (agent_kind, native_session_id, host) triple may appear at most once — the
-- invariant that lets the hub resolve a native pointer to one canonical session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_native_identity
  ON sessions(agent_kind, native_session_id, host)
  WHERE native_session_id IS NOT NULL;
`;
```

- [ ] **Step 4: Register the migration**

In `packages/store/src/migrations.ts`, update the import (line 2) and append migration 3:

```typescript
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from "./schema.ts";
```

```typescript
  {
    version: 3,
    up: (db) => {
      db.exec(SCHEMA_V3);
    },
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/store && bun test tests/migrations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/schema.ts packages/store/src/migrations.ts packages/store/tests/migrations.test.ts
git commit -m "store: v3 migration — sessions.origin + native-identity resolver index"
```

---

## Task 5: Store — origin in `decodeRow` + origin-aware liveness

**Files:**
- Modify: `packages/store/src/queries.ts:6-31`
- Modify: `packages/store/src/lost.ts`
- Test: `packages/store/tests/lost.test.ts:1` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/store/tests/lost.test.ts`:

```typescript
test("native rows are NOT marked lost by heartbeat staleness", () => {
  const long_ago = new Date(Date.now() - 10 * 60_000).toISOString();
  const now = new Date();
  // A native row with no heartbeat far in the past stays at its stored status.
  expect(computeEffectiveStatus(
    { status: "running", start_ts: long_ago, last_heartbeat_ts: null, origin: "native" }, now,
  )).toBe("running");
  // A wrapper row with the same staleness still goes lost (unchanged behavior).
  expect(computeEffectiveStatus(
    { status: "running", start_ts: long_ago, last_heartbeat_ts: null, origin: "wrapper" }, now,
  )).toBe("lost");
});

test("a native row already stored 'lost' stays lost (terminal)", () => {
  expect(computeEffectiveStatus(
    { status: "lost", start_ts: new Date().toISOString(), last_heartbeat_ts: null, origin: "native" },
  )).toBe("lost");
});
```

Note: the existing `lost.test.ts` cases pass rows without `origin`; that still type-checks because `origin` is optional on `RowForLostCheck` (Step 3) and they exercise the wrapper path by default.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && bun test tests/lost.test.ts`
Expected: FAIL — the native `running` row is computed `lost` (origin currently ignored).

- [ ] **Step 3: Make `computeEffectiveStatus` origin-aware**

Replace the contents of `packages/store/src/lost.ts` with:

```typescript
import { LOST_THRESHOLD_MS, type SessionStatus, type SessionOrigin, TERMINAL_STATUSES } from "@agmux/protocol";

interface RowForLostCheck {
  status: SessionStatus;
  start_ts: string;
  last_heartbeat_ts: string | null;
  // Optional so callers that only care about wrapper staleness need not pass it;
  // defaults to wrapper semantics (the historical behavior).
  origin?: SessionOrigin;
}

export function computeEffectiveStatus(row: RowForLostCheck, now: Date = new Date()): SessionStatus {
  if (TERMINAL_STATUSES.includes(row.status)) return row.status;
  // Native rows have no heartbeats: their liveness is driven by the hub's pid
  // sweep (which appends session.lost → stored status 'lost'), so heartbeat
  // staleness must NOT apply (spec §3). Report the stored status as-is.
  if (row.origin === "native") return row.status;
  const lastSeen = new Date(row.last_heartbeat_ts ?? row.start_ts).getTime();
  if (now.getTime() - lastSeen > LOST_THRESHOLD_MS) return "lost";
  return row.status;
}
```

- [ ] **Step 4: Read `origin` in `decodeRow`**

In `packages/store/src/queries.ts`, add to the object returned by `decodeRow` (after `status: raw.status as SessionStatus,`, line 28):

```typescript
    status: raw.status as SessionStatus,
    origin: (raw.origin ?? "wrapper") as SessionRow["origin"],
    turn_count: raw.turn_count ?? null,
```

(Both `getSessionRaw` and `listSessions` already `SELECT *` / `s.*`, so `origin` is present in the raw row; and both already call `computeEffectiveStatus(r, now)` — which now reads `r.origin`. No query-string change needed.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/store && bun test tests/lost.test.ts tests/queries.test.ts`
Expected: PASS (existing + 2 new lost tests; queries unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/lost.ts packages/store/src/queries.ts packages/store/tests/lost.test.ts
git commit -m "store: origin-aware liveness (native rows skip heartbeat staleness)"
```

---

## Task 6: Store — `applyRegistered` projection (mint / reopen / claim / rotate + lineage)

**Files:**
- Modify: `packages/store/src/project.ts`
- Test: `packages/store/tests/registered.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/registered.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";

function freshDb() { const db = new Database(":memory:"); runMigrations(db); return db; }
function regEv(sessionId: string, payload: Record<string, unknown>) {
  return {
    event_id: "e-" + sessionId, ts: "2026-06-08T00:00:00.000Z", session_id: sessionId,
    kind: "session.registered", version: 1, host: "h",
    payload: { agent_kind: "claude", tmux_session: null, tmux_window: null, tmux_pane: "%1",
      cwd: "/tmp", profile: null, agent_version: null, parent: null, ...payload },
  } as any;
}
function row(db: Database, sid: string) {
  return db.query<any, [string]>(`SELECT * FROM sessions WHERE session_id=?`).get(sid);
}

test("mint: a registered event with no prior row creates a native session", () => {
  const db = freshDb();
  applyEventToProjection(db, regEv("s-mint", { native_session_id: "n-1", pid: 4242 }));
  const r = row(db, "s-mint");
  expect(r.origin).toBe("native");
  expect(r.native_session_id).toBe("n-1");
  expect(r.pid).toBe(4242);
  expect(r.status).toBe("idle");
});

test("reopen: re-registering an ended row flips it back to idle and clears end fields", () => {
  const db = freshDb();
  applyEventToProjection(db, regEv("s-re", { native_session_id: "n-2", pid: 1 }));
  db.query(`UPDATE sessions SET status='ended', end_ts='x', exit_code=0 WHERE session_id=?`).run("s-re");
  applyEventToProjection(db, regEv("s-re", { native_session_id: "n-2", pid: 2 }));
  const r = row(db, "s-re");
  expect(r.status).toBe("idle");
  expect(r.end_ts).toBeNull();
  expect(r.exit_code).toBeNull();
  expect(r.pid).toBe(2);
});

test("claim/rotate: re-registering a live row sets its native_session_id", () => {
  const db = freshDb();
  // Simulate a wrapper-minted live row with a null native id (claim target).
  db.query(`INSERT INTO sessions (session_id, agent_kind, profile, native_session_id, command, args_json, env_json, cwd, host, start_ts, status, origin)
            VALUES ('s-claim','claude',NULL,NULL,'claude','[]','{}','/tmp','h','2026-06-08T00:00:00.000Z','running','wrapper')`).run();
  applyEventToProjection(db, regEv("s-claim", { native_session_id: "n-3", pid: 9 }));
  const r = row(db, "s-claim");
  expect(r.native_session_id).toBe("n-3");
  expect(r.origin).toBe("wrapper");   // claim does not rewrite origin
  expect(r.status).toBe("running");   // claim does not disturb live status
});

test("lineage: a resolvable parent hint writes parent_session_id", () => {
  const db = freshDb();
  applyEventToProjection(db, regEv("s-parent", { native_session_id: "p-nat", pid: 1 }));
  applyEventToProjection(db, regEv("s-child", { native_session_id: "c-nat", pid: 2,
    parent: { agent_kind: "claude", native_session_id: "p-nat" } }));
  expect(row(db, "s-child").parent_session_id).toBe("s-parent");
});

test("lineage: an unresolvable parent hint leaves parent_session_id null (no throw)", () => {
  const db = freshDb();
  applyEventToProjection(db, regEv("s-orphan", { native_session_id: "o-nat", pid: 1,
    parent: { agent_kind: "claude", native_session_id: "missing" } }));
  expect(row(db, "s-orphan").parent_session_id).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && bun test tests/registered.test.ts`
Expected: FAIL — `session.registered` hits the projection `default:` branch, so no row is created.

- [ ] **Step 3: Add the dispatch case**

In `packages/store/src/project.ts`, inside `applyEventToProjection`'s switch, add before the `case "session.linked":` line:

```typescript
    case "session.registered":
      applyRegistered(db, ev);
      return;
```

- [ ] **Step 4: Implement `applyRegistered`**

In `packages/store/src/project.ts`, add this function (place it after `applyLinked`, around line 144):

```typescript
// The native lifecycle root (spec §2.3). Keyed by the ALREADY-RESOLVED canonical
// session_id (resolveIngest picked it). We branch only on the current row state:
//   absent           → mint a fresh native row from the payload
//   ended/lost       → reopen (rule 1): back to idle, clear terminal fields
//   live             → set native_session_id (covers claim, rotate, and re-register)
// Then resolve the optional parent lineage hint (spec §5); unresolvable → leave null.
function applyRegistered(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  const existing = db.query<{ status: string }, [string]>(
    `SELECT status FROM sessions WHERE session_id = ?`,
  ).get(ev.session_id);

  if (!existing) {
    db.query(`
      INSERT INTO sessions (
        session_id, agent_kind, profile, native_session_id,
        command, args_json, env_json, cwd, pid,
        tmux_session, tmux_window, tmux_pane, host,
        project, parent_session_id, start_ts, last_heartbeat_ts,
        end_ts, exit_code, signal, status, origin
      ) VALUES (
        ?, ?, ?, ?,
        ?, '[]', '{}', ?, ?,
        ?, ?, ?, ?,
        NULL, NULL, ?, NULL,
        NULL, NULL, NULL, 'idle', 'native'
      )
      ON CONFLICT(session_id) DO NOTHING
    `).run(
      ev.session_id, p.agent_kind, p.profile ?? null, p.native_session_id,
      p.command ?? p.agent_kind, p.cwd ?? "", p.pid ?? null,
      p.tmux_session ?? null, p.tmux_window ?? null, p.tmux_pane ?? null, ev.host,
      ev.ts,
    );
  } else if (existing.status === "ended" || existing.status === "lost") {
    db.query(`
      UPDATE sessions SET
        status = 'idle', end_ts = NULL, exit_code = NULL, signal = NULL,
        native_session_id = ?,
        pid = COALESCE(?, pid),
        tmux_session = COALESCE(?, tmux_session),
        tmux_window  = COALESCE(?, tmux_window),
        tmux_pane    = COALESCE(?, tmux_pane)
      WHERE session_id = ?
    `).run(p.native_session_id, p.pid ?? null, p.tmux_session ?? null, p.tmux_window ?? null, p.tmux_pane ?? null, ev.session_id);
  } else {
    db.query(`
      UPDATE sessions SET
        native_session_id = ?,
        pid = COALESCE(?, pid),
        tmux_session = COALESCE(?, tmux_session),
        tmux_window  = COALESCE(?, tmux_window),
        tmux_pane    = COALESCE(?, tmux_pane)
      WHERE session_id = ?
    `).run(p.native_session_id, p.pid ?? null, p.tmux_session ?? null, p.tmux_window ?? null, p.tmux_pane ?? null, ev.session_id);
  }

  const par = p.parent;
  if (par && typeof par.agent_kind === "string" && typeof par.native_session_id === "string") {
    const pr = db.query<{ session_id: string }, [string, string, string]>(
      `SELECT session_id FROM sessions WHERE agent_kind = ? AND native_session_id = ? AND host = ?`,
    ).get(par.agent_kind, par.native_session_id, ev.host);
    if (pr) {
      db.query(`UPDATE sessions SET parent_session_id = ? WHERE session_id = ? AND parent_session_id IS NULL`)
        .run(pr.session_id, ev.session_id);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/store && bun test tests/registered.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/project.ts packages/store/tests/registered.test.ts
git commit -m "store: applyRegistered projection (mint/reopen/claim/rotate + lineage)"
```

---

## Task 7: Store — `applyLost` projection

**Files:**
- Modify: `packages/store/src/project.ts`
- Test: `packages/store/tests/lost-event.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/lost-event.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";

function freshDb() { const db = new Database(":memory:"); runMigrations(db); return db; }
function liveNative(db: Database, sid: string) {
  db.query(`INSERT INTO sessions (session_id, agent_kind, profile, native_session_id, command, args_json, env_json, cwd, host, start_ts, status, origin)
            VALUES (?, 'claude', NULL, ?, 'claude', '[]', '{}', '/tmp', 'h', '2026-06-08T00:00:00.000Z', 'running', 'native')`).run(sid, "nat-" + sid);
}
function lostEv(sid: string) {
  return { event_id: "el-" + sid, ts: "2026-06-08T00:01:00.000Z", session_id: sid,
    kind: "session.lost", version: 1, host: "h", payload: { reason: "pid_dead" } } as any;
}
function statusOf(db: Database, sid: string) {
  return db.query<{ status: string }, [string]>(`SELECT status FROM sessions WHERE session_id=?`).get(sid)!.status;
}

test("session.lost sets a live native session to 'lost'", () => {
  const db = freshDb(); liveNative(db, "s-l");
  applyEventToProjection(db, lostEv("s-l"));
  expect(statusOf(db, "s-l")).toBe("lost");
});

test("session.lost never overrides an 'ended' session", () => {
  const db = freshDb(); liveNative(db, "s-e");
  db.query(`UPDATE sessions SET status='ended' WHERE session_id=?`).run("s-e");
  applyEventToProjection(db, lostEv("s-e"));
  expect(statusOf(db, "s-e")).toBe("ended");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && bun test tests/lost-event.test.ts`
Expected: FAIL — `session.lost` falls into `default:`, status stays `running`.

- [ ] **Step 3: Add dispatch + handler**

In `packages/store/src/project.ts`, add a dispatch case (after the `session.registered` case from Task 6):

```typescript
    case "session.lost":
      applyLost(db, ev);
      return;
```

Add the handler (place after `applyEnded`, around line 115):

```typescript
// Hub-emitted pid-sweep observation (spec §3). A dead native pid → 'lost'. Never
// overrides 'ended' (a clean exit already happened); 'lost' is itself terminal.
function applyLost(db: Database, ev: EventEnvelope): void {
  db.query(`UPDATE sessions SET status = 'lost' WHERE session_id = ? AND status NOT IN ('ended')`)
    .run(ev.session_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/store && bun test tests/lost-event.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/project.ts packages/store/tests/lost-event.test.ts
git commit -m "store: applyLost projection (pid-sweep → lost, never over ended)"
```

---

## Task 8: Store — `resolveIngest` (the four rules) + `Store.resolveAndAppend`

**Files:**
- Create: `packages/store/src/resolve.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/resolve.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/resolve.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { resolveIngest } from "../src/resolve.ts";

function freshDb() { const db = new Database(":memory:"); runMigrations(db); return db; }
function regWire(extra: Record<string, unknown> = {}) {
  return {
    event_id: "e1", ts: "2026-06-08T00:00:00.000Z", kind: "session.registered",
    version: 1, host: "h",
    identity: { agent_kind: "claude", native_session_id: "N" },
    payload: { agent_kind: "claude", native_session_id: "N", pid: 4242, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: null, profile: null, agent_version: null, parent: null },
    ...extra,
  };
}
function liveRow(db: Database, sid: string, opts: { native?: string | null; pid?: number; status?: string } = {}) {
  db.query(`INSERT INTO sessions (session_id, agent_kind, profile, native_session_id, command, args_json, env_json, cwd, pid, host, start_ts, status, origin)
            VALUES (?, 'claude', NULL, ?, 'claude', '[]', '{}', '/tmp', ?, 'h', '2026-06-08T00:00:00.000Z', ?, 'wrapper')`)
    .run(sid, opts.native ?? null, opts.pid ?? null, opts.status ?? "running");
}

test("canonical form passes through unchanged", () => {
  const db = freshDb();
  const r = resolveIngest(db, { event_id: "c", ts: "t", kind: "turn.started", version: 1, host: "h", session_id: "sid-c", payload: {} });
  expect(r.action).toBe("append");
  if (r.action === "append") expect(r.ev.session_id).toBe("sid-c");
});

test("rule 1 (known): native event resolves to the mapped canonical session", () => {
  const db = freshDb(); liveRow(db, "s-known", { native: "N" });
  const r = resolveIngest(db, { event_id: "t", ts: "t", kind: "turn.started", version: 1, host: "h",
    identity: { agent_kind: "claude", native_session_id: "N" }, payload: {} });
  expect(r.action).toBe("append");
  if (r.action === "append") expect(r.ev.session_id).toBe("s-known");
});

test("a non-registration native event for an UNKNOWN session is dropped", () => {
  const db = freshDb();
  const r = resolveIngest(db, { event_id: "t", ts: "t", kind: "turn.started", version: 1, host: "h",
    identity: { agent_kind: "claude", native_session_id: "ghost" }, payload: {} });
  expect(r.action).toBe("drop");
});

test("rule 2 (claim): registration adopts a live, same-kind, null-native session", () => {
  const db = freshDb(); liveRow(db, "s-wrap", { native: null });
  const r = resolveIngest(db, regWire({ claim_session_id: "s-wrap" }));
  expect(r.action).toBe("append");
  if (r.action === "append") expect(r.ev.session_id).toBe("s-wrap");
});

test("rule 2 does NOT claim when the target already has a different native id (stale env / summarizer)", () => {
  const db = freshDb(); liveRow(db, "s-wrap", { native: "other" });
  const r = resolveIngest(db, regWire({ claim_session_id: "s-wrap" }), { newSessionId: () => "MINTED" });
  expect(r.action).toBe("append");
  if (r.action === "append") expect(r.ev.session_id).toBe("MINTED"); // falls through to mint
});

test("rule 3 (rotate): registration with same (host,pid,kind) but new native id adopts that row", () => {
  const db = freshDb(); liveRow(db, "s-rot", { native: "old", pid: 4242 });
  const r = resolveIngest(db, regWire()); // pid 4242, native N, no claim
  expect(r.action).toBe("append");
  if (r.action === "append") expect(r.ev.session_id).toBe("s-rot");
});

test("rule 4 (mint): nothing matches → fresh canonical id", () => {
  const db = freshDb();
  const r = resolveIngest(db, regWire(), { newSessionId: () => "FRESH" });
  expect(r.action).toBe("append");
  if (r.action === "append") expect(r.ev.session_id).toBe("FRESH");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && bun test tests/resolve.test.ts`
Expected: FAIL — `Cannot find module "../src/resolve.ts"`.

- [ ] **Step 3: Create `resolve.ts`**

Create `packages/store/src/resolve.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { EventEnvelope, SessionStatus } from "@agmux/protocol";
import { LIVE_STATUSES, mintSessionId } from "@agmux/protocol";

// The wire shape accepted at ingest (structurally an IngestEnvelope; kept local
// and permissive so the store needn't depend on the exact protocol generic).
export interface IngestEnvelopeLike {
  event_id: string;
  ts: string;
  kind: string;
  version: number;
  host: string;
  payload: any;
  dedup_key?: string | null;
  session_id?: string | null;
  identity?: { agent_kind: string; native_session_id: string } | null;
  claim_session_id?: string | null;
}

export type ResolveResult =
  | { action: "append"; ev: EventEnvelope }
  | { action: "drop"; reason: string };

function toStorage(ing: IngestEnvelopeLike, sessionId: string): EventEnvelope {
  return {
    event_id: ing.event_id, ts: ing.ts, session_id: sessionId, kind: ing.kind,
    version: ing.version, host: ing.host, payload: ing.payload, dedup_key: ing.dedup_key ?? null,
  };
}

const isLive = (s: string): boolean => (LIVE_STATUSES as readonly string[]).includes(s);

// Pick the canonical session_id for a wire envelope (spec §2.3). READ-ONLY: it
// only decides the id; the projection (applyRegistered) does the writes. The four
// ordered rules apply to native-form registrations; non-registration native
// events resolve by rule 1 only and are otherwise dropped.
export function resolveIngest(
  db: Database,
  ing: IngestEnvelopeLike,
  deps: { newSessionId?: () => string } = {},
): ResolveResult {
  if (ing.session_id) return { action: "append", ev: toStorage(ing, ing.session_id) };

  const id = ing.identity;
  if (!id) return { action: "drop", reason: "envelope has neither session_id nor identity" };
  const K = id.agent_kind, N = id.native_session_id, H = ing.host;

  // Rule 1 — Known.
  const known = db.query<{ session_id: string }, [string, string, string]>(
    `SELECT session_id FROM sessions WHERE agent_kind = ? AND native_session_id = ? AND host = ?`,
  ).get(K, N, H);
  if (known) return { action: "append", ev: toStorage(ing, known.session_id) };

  if (ing.kind !== "session.registered") {
    return { action: "drop", reason: "native telemetry for an unregistered session" };
  }

  // Rule 2 — Claim (wrapped bridge): adopt a live, same-kind session whose native
  // id is still null. A stale inherited env (the summarizer) names a session that
  // already has a DIFFERENT native id, so it fails this rule and falls through.
  const C = ing.claim_session_id ?? null;
  if (C) {
    const t = db.query<{ status: SessionStatus; agent_kind: string; native_session_id: string | null }, [string]>(
      `SELECT status, agent_kind, native_session_id FROM sessions WHERE session_id = ?`,
    ).get(C);
    if (t && isLive(t.status) && t.agent_kind === K && t.native_session_id == null) {
      return { action: "append", ev: toStorage(ing, C) };
    }
  }

  // Rule 3 — Pid rotation: a live (host, pid, kind) row whose native id differs
  // (/clear or compaction rotated the native id in-process) → adopt it.
  const pid = typeof ing.payload?.pid === "number" ? ing.payload.pid : null;
  if (pid != null) {
    const placeholders = LIVE_STATUSES.map(() => "?").join(", ");
    const rot = db.query<{ session_id: string }, any[]>(
      `SELECT session_id FROM sessions
         WHERE host = ? AND pid = ? AND agent_kind = ? AND status IN (${placeholders})
           AND (native_session_id IS NULL OR native_session_id <> ?)
         ORDER BY start_ts DESC LIMIT 1`,
    ).get(H, pid, K, ...LIVE_STATUSES, N);
    if (rot) return { action: "append", ev: toStorage(ing, rot.session_id) };
  }

  // Rule 4 — Mint.
  const sid = (deps.newSessionId ?? mintSessionId)();
  return { action: "append", ev: toStorage(ing, sid) };
}
```

- [ ] **Step 4: Add `Store.resolveAndAppend` + export**

In `packages/store/src/index.ts`, add the import near the top (with the other imports):

```typescript
import { resolveIngest, type IngestEnvelopeLike } from "./resolve.ts";
```

Add this method to the `Store` class (after `append`, around line 38):

```typescript
  /**
   * Resolve a wire envelope to a canonical session and append it. Native-form
   * events are mapped via resolveIngest (spec §2.3); unresolvable telemetry is
   * dropped. Returns true if an event was appended (false on drop OR dedup).
   */
  resolveAndAppend(ing: IngestEnvelopeLike): boolean {
    const r = resolveIngest(this.db, ing);
    if (r.action === "drop") return false;
    return this.append(r.ev);
  }
```

At the bottom of `packages/store/src/index.ts`, re-export resolve symbols (next to the other `export *`/exports — check the file for an existing exports block; if none, add):

```typescript
export { resolveIngest, type IngestEnvelopeLike, type ResolveResult } from "./resolve.ts";
```

(If `packages/store/src/index.ts` does not already re-export `queries`/`project` symbols, leave those as-is; only add the resolve export.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/store && bun test tests/resolve.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/resolve.ts packages/store/src/index.ts packages/store/tests/resolve.test.ts
git commit -m "store: resolveIngest (4-rule native identity resolution) + resolveAndAppend"
```

---

## Task 9: Store — `listLiveNativeSessions` query (pid-sweep candidates)

**Files:**
- Modify: `packages/store/src/queries.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/queries.test.ts:1` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/store/tests/queries.test.ts`:

```typescript
import { listLiveNativeSessions } from "../src/queries.ts";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";

test("listLiveNativeSessions returns only live native rows on this host with a pid", () => {
  const db = new Database(":memory:"); runMigrations(db);
  const ins = (sid: string, origin: string, status: string, pid: number | null, host: string) =>
    db.query(`INSERT INTO sessions (session_id, agent_kind, profile, native_session_id, command, args_json, env_json, cwd, pid, host, start_ts, status, origin)
              VALUES (?, 'claude', NULL, ?, 'claude', '[]', '{}', '/tmp', ?, ?, '2026-06-08T00:00:00.000Z', ?, ?)`)
      .run(sid, "nat-" + sid, pid, host, status, origin);
  ins("a", "native", "running", 100, "h");   // included
  ins("b", "native", "idle", 101, "h");       // included
  ins("c", "native", "ended", 102, "h");      // excluded: not live
  ins("d", "wrapper", "running", 103, "h");   // excluded: not native
  ins("e", "native", "running", null, "h");   // excluded: no pid
  ins("f", "native", "running", 104, "other");// excluded: other host

  const rows = listLiveNativeSessions(db, "h");
  expect(rows.map((r) => r.session_id).sort()).toEqual(["a", "b"]);
  expect(rows.find((r) => r.session_id === "a")!.pid).toBe(100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/store && bun test tests/queries.test.ts`
Expected: FAIL — `listLiveNativeSessions` not exported.

- [ ] **Step 3: Implement the query**

In `packages/store/src/queries.ts`, add at the end of the file:

```typescript
// pid-sweep candidates (spec §3): live native rows on a given host that carry a
// pid. Cross-host native rows are intentionally excluded (never pid-swept).
export function listLiveNativeSessions(db: Database, host: string): { session_id: string; pid: number }[] {
  return db.query<{ session_id: string; pid: number }, [string]>(
    `SELECT session_id, pid FROM sessions
       WHERE origin = 'native' AND pid IS NOT NULL AND host = ?
         AND status IN ('idle', 'running', 'waiting')`,
  ).all(host);
}
```

- [ ] **Step 4: Add a `Store` convenience method + export**

In `packages/store/src/index.ts`, import it (extend the queries import if present, else add):

```typescript
import { listLiveNativeSessions } from "./queries.ts";
```

Add to the `Store` class (after `getSessionUsage`, around line 60):

```typescript
  listLiveNativeSessions(host: string): { session_id: string; pid: number }[] {
    return listLiveNativeSessions(this.db, host);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/store && bun test tests/queries.test.ts`
Expected: PASS (existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/queries.ts packages/store/src/index.ts packages/store/tests/queries.test.ts
git commit -m "store: listLiveNativeSessions for the hub pid-sweep"
```

---

## Task 10: Hub — `/ingest` accepts native identity (resolve + append)

**Files:**
- Modify: `packages/hub/src/server.ts:27-40`
- Test: `packages/hub/tests/server.test.ts:1` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/hub/tests/server.test.ts`:

```typescript
test("POST /ingest mints a session for a native session.registered event", async () => {
  const { server, url, store } = makeServer();
  const wire = {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q", ts: new Date().toISOString(),
    kind: "session.registered", version: 1, host: "macbook.local",
    identity: { agent_kind: "claude", native_session_id: "nat-xyz" },
    payload: { agent_kind: "claude", native_session_id: "nat-xyz", pid: 4242, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: "%1", profile: null, agent_version: null, parent: null },
  };
  const r = await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(wire),
  });
  expect(r.status).toBe(202);
  const minted = store.listSessions({}).find((s) => s.native_session_id === "nat-xyz");
  expect(minted).toBeDefined();
  expect(minted!.origin).toBe("native");
  server.stop();
});

test("POST /ingest rejects an envelope with neither session_id nor identity", async () => {
  const { server, url } = makeServer();
  const bad = { event_id: "x", ts: new Date().toISOString(), kind: "turn.started", version: 1, host: "h", payload: {} };
  const r = await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bad),
  });
  expect(r.status).toBe(400);
  server.stop();
});
```

(The existing canonical-form `/ingest` tests must continue to pass — `validateIngestEnvelope` accepts `session_id`, and `resolveAndAppend` passes it through.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && bun test tests/server.test.ts`
Expected: FAIL — the registered event is rejected 400 (current `validateEnvelope` requires `session_id`); the mint never happens.

- [ ] **Step 3: Switch `/ingest` to the ingest validator + resolver**

In `packages/hub/src/server.ts`, update the import (top of file) from:

```typescript
import { validateEnvelope, validateKnownPayload } from "@agmux/protocol";
import type { EventEnvelope } from "@agmux/protocol";
```

to:

```typescript
import { validateIngestEnvelope, validateKnownPayload } from "@agmux/protocol";
import type { IngestEnvelope } from "@agmux/protocol";
```

Then replace the `/ingest` loop body (lines 27-40) with:

```typescript
      if (m === "POST" && url.pathname === "/ingest") {
        let body: unknown;
        try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
        const events = Array.isArray(body) ? body : [body];
        for (const ev of events) {
          const env = validateIngestEnvelope(ev);
          if (!env.ok) return Response.json({ error: env.error }, { status: 400 });
          const e = ev as IngestEnvelope;
          const pl = validateKnownPayload(e.kind, e.payload);
          if (!pl.ok) return Response.json({ error: pl.error }, { status: 400 });
          store.resolveAndAppend(e); // resolves native identity, idempotent, drops unresolvable telemetry
        }
        return new Response(null, { status: 202 });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && bun test tests/server.test.ts`
Expected: PASS (existing canonical tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/server.ts packages/hub/tests/server.test.ts
git commit -m "hub: /ingest accepts native identity via resolveAndAppend"
```

---

## Task 11: Hub — native pid-sweep liveness

**Files:**
- Create: `packages/hub/src/liveness.ts`
- Modify: `packages/hub/src/index.ts`
- Modify: `packages/hub/bin/agmux-hub.ts`
- Test: `packages/hub/tests/liveness.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/hub/tests/liveness.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { Store } from "@agmux/store";
import { sweepNativeLiveness, buildLostEvent } from "../src/liveness.ts";

function nativeRow(store: Store, sid: string, pid: number, host = "h") {
  store.append({
    event_id: "reg-" + sid, ts: new Date().toISOString(), session_id: sid,
    kind: "session.registered", version: 1, host,
    payload: { agent_kind: "claude", native_session_id: "nat-" + sid, pid, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: null, profile: null, agent_version: null, parent: null },
  } as any);
}

test("buildLostEvent produces a valid session.lost envelope", () => {
  const ev = buildLostEvent({ sessionId: "s1", host: "h", now: () => "2026-06-08T00:00:00.000Z", newId: () => "id1" });
  expect(ev).toEqual({ event_id: "id1", ts: "2026-06-08T00:00:00.000Z", session_id: "s1",
    kind: "session.lost", version: 1, host: "h", payload: { reason: "pid_dead" }, dedup_key: null });
});

test("sweepNativeLiveness marks dead pids lost and leaves live ones idle", () => {
  const store = Store.openInMemory();
  nativeRow(store, "alive", 100);   // a freshly registered native row is 'idle'
  nativeRow(store, "dead", 200);
  const lost = sweepNativeLiveness(store, { host: "h", isAlive: (pid) => pid === 100 });
  expect(lost).toBe(1);
  expect(store.getSession("dead")!.status).toBe("lost");
  expect(store.getSession("alive")!.status).toBe("idle");
  store.close();
});

test("sweepNativeLiveness ignores other hosts", () => {
  const store = Store.openInMemory();
  nativeRow(store, "remote", 300, "elsewhere");
  const lost = sweepNativeLiveness(store, { host: "h", isAlive: () => false });
  expect(lost).toBe(0);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && bun test tests/liveness.test.ts`
Expected: FAIL — `Cannot find module "../src/liveness.ts"`.

- [ ] **Step 3: Create `liveness.ts`**

Create `packages/hub/src/liveness.ts`:

```typescript
import type { EventEnvelope } from "@agmux/protocol";
import { HEARTBEAT_INTERVAL_MS } from "@agmux/protocol";
import type { Store } from "@agmux/store";
import { isProcessAlive } from "./bootstrap.ts";

// Build the canonical session.lost observation appended when a native pid is gone.
export function buildLostEvent(o: { sessionId: string; host: string; now?: () => string; newId?: () => string }): EventEnvelope {
  const now = o.now ?? (() => new Date().toISOString());
  const newId = o.newId ?? (() => crypto.randomUUID());
  return {
    event_id: newId(), ts: now(), session_id: o.sessionId, kind: "session.lost",
    version: 1, host: o.host, payload: { reason: "pid_dead" }, dedup_key: null,
  };
}

// One sweep pass (spec §3): for every live native row on this host, kill -0 its
// pid; a dead pid appends session.lost. Returns the count newly marked lost.
// isAlive is injectable for tests. Pid reuse is an accepted v1 edge (spec §8).
export function sweepNativeLiveness(
  store: Store,
  o: { host: string; isAlive?: (pid: number) => boolean; now?: () => string },
): number {
  const isAlive = o.isAlive ?? isProcessAlive;
  let lost = 0;
  for (const r of store.listLiveNativeSessions(o.host)) {
    if (!isAlive(r.pid)) {
      store.append(buildLostEvent({ sessionId: r.session_id, host: o.host, now: o.now }));
      lost++;
    }
  }
  return lost;
}

// Start the periodic sweep. Returns a stop function. Errors in a pass are
// swallowed (a sweep failure must never crash the hub).
export function startNativeLivenessSweep(store: Store, host: string, intervalMs: number = HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    try { sweepNativeLiveness(store, { host }); } catch { /* never crash the hub */ }
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Export from the hub index**

In `packages/hub/src/index.ts`, add:

```typescript
export * from "./liveness.ts";
```

- [ ] **Step 5: Wire the sweep into the hub binary**

In `packages/hub/bin/agmux-hub.ts`, add the import (with the others):

```typescript
import { startNativeLivenessSweep } from "../src/liveness.ts";
```

After the `console.log(`agmux-hub listening ...`)` line, add:

```typescript
const stopSweep = startNativeLivenessSweep(store, os.hostname());
```

In the `shutdown` function, add `stopSweep();` before `server.stop();`:

```typescript
const shutdown = () => {
  try { fs.unlinkSync(path.join(stateDir, "hub.pid")); } catch {}
  try { fs.unlinkSync(path.join(stateDir, "hub.port")); } catch {}
  stopSweep();
  lock.release();
  server.stop();
  process.exit(0);
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/hub && bun test tests/liveness.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/liveness.ts packages/hub/src/index.ts packages/hub/bin/agmux-hub.ts packages/hub/tests/liveness.test.ts
git commit -m "hub: native pid-sweep liveness (session.lost on dead pid)"
```

---

## Task 12: Hub — drain queued native events through resolution

**Files:**
- Modify: `packages/hub/src/drain.ts`
- Test: `packages/hub/tests/drain.test.ts` (Create if absent, else extend)

- [ ] **Step 1: Write the failing test**

Create (or append to) `packages/hub/tests/drain.test.ts`:

```typescript
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "@agmux/store";
import { drainQueueDir } from "../src/drain.ts";

function tmpQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-drain-"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("drain resolves a queued native session.registered into a minted session", () => {
  const dir = tmpQueue();
  const store = Store.openInMemory();
  const wire = {
    event_id: "qd-1", ts: new Date().toISOString(), kind: "session.registered", version: 1, host: "h",
    identity: { agent_kind: "claude", native_session_id: "queued-nat" },
    payload: { agent_kind: "claude", native_session_id: "queued-nat", pid: 7, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: null, profile: null, agent_version: null, parent: null },
  };
  fs.writeFileSync(path.join(dir, "queued-nat.jsonl"), JSON.stringify(wire) + "\n");

  const r = drainQueueDir(dir, store);
  expect(r.eventsIngested).toBe(1);
  expect(store.listSessions({}).some((s) => s.native_session_id === "queued-nat")).toBe(true);
  store.close();
});

test("drain still ingests a canonical (session_id) queued event", () => {
  const dir = tmpQueue();
  const store = Store.openInMemory();
  const ev = {
    event_id: "qd-2", ts: new Date().toISOString(), kind: "session.started", version: 1, host: "h",
    session_id: "0190a3e0-0000-7000-8000-000000000abc",
    payload: { agent_kind: "claude", profile: null, command: "c", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
      tmux_session: null, tmux_window: null, tmux_pane: null, project: null },
  };
  fs.writeFileSync(path.join(dir, "canon.jsonl"), JSON.stringify(ev) + "\n");
  const r = drainQueueDir(dir, store);
  expect(r.eventsIngested).toBe(1);
  expect(store.getSession("0190a3e0-0000-7000-8000-000000000abc")).toBeTruthy();
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && bun test tests/drain.test.ts`
Expected: FAIL — the native event is skipped (`validateEnvelope` rejects the missing `session_id`), so `eventsIngested` is 0 and no session is minted.

- [ ] **Step 3: Route drain through the ingest validator + resolver**

Replace `packages/hub/src/drain.ts` with:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "@agmux/store";
import { validateIngestEnvelope } from "@agmux/protocol";

export interface DrainResult { filesDrained: number; eventsIngested: number; linesSkipped: number; }

export function drainQueueDir(dir: string, store: Store): DrainResult {
  const r: DrainResult = { filesDrained: 0, eventsIngested: 0, linesSkipped: 0 };
  if (!fs.existsSync(dir)) return r;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    const content = fs.readFileSync(full, "utf8");
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { r.linesSkipped++; continue; }
      const v = validateIngestEnvelope(parsed);
      if (!v.ok) { r.linesSkipped++; continue; }
      // Resolve native identity against the CURRENT mapping (spec §2.1); idempotent.
      const appended = store.resolveAndAppend(parsed as any);
      if (appended) r.eventsIngested++; else r.linesSkipped++;
    }
    fs.unlinkSync(full);
    r.filesDrained++;
  }
  return r;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && bun test tests/drain.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/drain.ts packages/hub/tests/drain.test.ts
git commit -m "hub: drain resolves queued native-identity events at startup"
```

---

## Task 13: Adapters core — `session.registered` manifest point, `nativeIdFromEnv`, `stampIngestEvents`

**Files:**
- Modify: `packages/adapters/src/core/types.ts`
- Modify: `packages/adapters/src/core/normalize.ts`
- Modify: `packages/adapters/tests/fixtures/fake-adapter.ts`
- Test: `packages/adapters/tests/normalize.test.ts:1` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/normalize.test.ts`:

```typescript
import { stampIngestEvents } from "../src/core/normalize.ts";

const ts = () => "2026-06-08T00:00:00.000Z";
let seq = 0;
const nid = () => "id-" + (++seq);

test("stampIngestEvents uses the native identity form when a native id is given", () => {
  seq = 0;
  const out = stampIngestEvents([{ kind: "turn.started", payload: {}, dedup_key: null }], {
    agentKind: "claude", nativeId: "nat-1", claimId: "claim-1", host: "h", now: ts, newId: nid,
  });
  expect(out).toHaveLength(1);
  expect(out[0]).toEqual({
    event_id: "id-1", ts: "2026-06-08T00:00:00.000Z", kind: "turn.started", version: 1, host: "h",
    payload: {}, dedup_key: null,
    identity: { agent_kind: "claude", native_session_id: "nat-1" }, claim_session_id: "claim-1",
  });
});

test("stampIngestEvents falls back to the canonical form when no native id", () => {
  seq = 0;
  const out = stampIngestEvents([{ kind: "turn.started", payload: {}, dedup_key: null }], {
    agentKind: "claude", nativeId: null, claimId: "claim-9", host: "h", now: ts, newId: nid,
  });
  expect(out[0].session_id).toBe("claim-9");
  expect(out[0].identity).toBeUndefined();
});
```

Also extend `packages/adapters/tests/manifest.test.ts` (or `normalize.test.ts`) with:

```typescript
import { MANIFEST_POINTS } from "../src/core/types.ts";
test("session.registered is a manifest point", () => {
  expect(MANIFEST_POINTS).toContain("session.registered");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/adapters && bun test tests/normalize.test.ts`
Expected: FAIL — `stampIngestEvents` not exported; `MANIFEST_POINTS` lacks `session.registered`.

- [ ] **Step 3: Add the manifest point + adapter member**

In `packages/adapters/src/core/types.ts`, add `"session.registered"` as the first entry of `MANIFEST_POINTS`:

```typescript
export const MANIFEST_POINTS = [
  "session.registered",
  "session.linked",
  "turn.started",
  "turn.ended",
  "input.required",
  "input.received",
  "usage.reported",
  "tool.used",
  "prompt.sent",
] as const;
```

Add the optional member to the `Adapter` interface (after `resumePlan(...)`):

```typescript
  resumePlan(ctx: ResumeContext): ResumePlan;
  // Native-first (spec §5): the agent's OWN native id read from its hook/tool env
  // (claude: CLAUDE_CODE_SESSION_ID). Used by `emit` to stamp native identity and
  // by the future spawn path to name a parent. Optional: adapters without a native
  // env signal omit it and fall back to canonical (claim) identity.
  nativeIdFromEnv?(env: Record<string, string | undefined>): string | null;
```

- [ ] **Step 4: Add `stampIngestEvents`**

In `packages/adapters/src/core/normalize.ts`, add (keep the existing `stampEvents`):

```typescript
import type { EventEnvelope, IngestEnvelope, AgentKind } from "@agmux/protocol";
```

(Extend the existing protocol import rather than duplicating; `EventEnvelope` is already imported — add `IngestEnvelope, AgentKind`.)

```typescript
export interface StampIngestOpts {
  agentKind: AgentKind;
  nativeId: string | null;   // the agent's own native id, if known
  claimId: string | null;    // AGMUX_SESSION_ID (wrapper bridge), if set
  host: string;
  now?: () => string;
  newId?: () => string;
}

// Wrap canonical events into WIRE envelopes (spec §2). When a native id is known
// the event names itself natively (identity + claim hint); otherwise it falls
// back to the canonical session_id (claimId). Callers must ensure at least one of
// nativeId/claimId is set (emit drops otherwise).
export function stampIngestEvents(events: CanonicalEvent[], opts: StampIngestOpts): IngestEnvelope[] {
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? (() => ulid());
  return events.map((e) => {
    const base = {
      event_id: newId(), ts: now(), kind: e.kind, version: 1, host: opts.host,
      payload: e.payload, dedup_key: e.dedup_key ?? null,
    };
    if (opts.nativeId) {
      return { ...base, identity: { agent_kind: opts.agentKind, native_session_id: opts.nativeId }, claim_session_id: opts.claimId ?? null };
    }
    return { ...base, session_id: opts.claimId };
  });
}
```

- [ ] **Step 5: Give the fake adapter a `nativeIdFromEnv`**

In `packages/adapters/tests/fixtures/fake-adapter.ts`, add to the `fakeAdapter` object (after `resumePlan`):

```typescript
  nativeIdFromEnv(env): string | null {
    return env.FAKE_NATIVE_ID ?? null;
  },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/adapters && bun test tests/normalize.test.ts tests/manifest.test.ts tests/conformance.test.ts`
Expected: PASS (existing + new; conformance still green since `nativeIdFromEnv` is optional).

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/core/types.ts packages/adapters/src/core/normalize.ts packages/adapters/tests/fixtures/fake-adapter.ts packages/adapters/tests/normalize.test.ts packages/adapters/tests/manifest.test.ts
git commit -m "adapters: session.registered manifest point, nativeIdFromEnv, stampIngestEvents"
```

---

## Task 14: Claude adapter — register `session.registered`, normalize it, plugin v1.2.0

**Files:**
- Modify: `packages/adapters/src/adapters/claude/caps.ts`
- Modify: `packages/adapters/src/adapters/claude/normalize.ts`
- Modify: `packages/adapters/src/adapters/claude/index.ts`
- Modify: `packages/adapters/src/adapters/claude/plugin-files.ts`
- Test: `packages/adapters/tests/adapters/claude.test.ts:1` (extend)
- Test: `packages/adapters/tests/adapters/claude-plugin.test.ts:1` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `packages/adapters/tests/adapters/claude.test.ts`:

```typescript
import { claudeAdapter } from "../../src/adapters/claude/index.ts";

test("claude normalize(session.registered) builds the native lifecycle root from stdin + env", () => {
  const out = claudeAdapter.normalize({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-9", cwd: "/work" },
    target: { agentKind: "claude", profile: null },
    env: { AGMUX_AGENT_PID: "5151", TMUX_PANE: "%4", AGMUX_PROFILE: "work", CLAUDE_CODE_SESSION_ID: "nat-9" },
  });
  expect(out.events).toHaveLength(1);
  const p = out.events[0].payload as any;
  expect(out.events[0].kind).toBe("session.registered");
  expect(p.native_session_id).toBe("nat-9");
  expect(p.agent_kind).toBe("claude");
  expect(p.pid).toBe(5151);
  expect(p.cwd).toBe("/work");
  expect(p.tmux_pane).toBe("%4");
  expect(p.profile).toBe("work");
  expect(p.parent).toBeNull();
});

test("claude normalize(session.registered) stores null pid when AGMUX_AGENT_PID is absent/garbage", () => {
  const out = claudeAdapter.normalize({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-x" }, target: { agentKind: "claude", profile: null },
    env: { CLAUDE_CODE_SESSION_ID: "nat-x", AGMUX_AGENT_PID: "notanum" },
  });
  expect((out.events[0].payload as any).pid).toBeNull();
});

test("claude nativeIdFromEnv reads CLAUDE_CODE_SESSION_ID", () => {
  expect(claudeAdapter.nativeIdFromEnv!({ CLAUDE_CODE_SESSION_ID: "abc" })).toBe("abc");
  expect(claudeAdapter.nativeIdFromEnv!({})).toBeNull();
});
```

Append to `packages/adapters/tests/adapters/claude-plugin.test.ts`:

```typescript
test("plugin is v1.2.0 and SessionStart emits session.registered with AGMUX_AGENT_PID, not session.linked", () => {
  const manifest = JSON.parse(PLUGIN_FILES.find((f) => f.path === ".claude-plugin/plugin.json")!.content);
  expect(manifest.version).toBe("1.2.0");
  const hooks = JSON.parse(PLUGIN_FILES.find((f) => f.path === "hooks/hooks.json")!.content);
  const startCmds = hooks.hooks.SessionStart[0].hooks.map((h: any) => h.command).join("\n");
  expect(startCmds).toContain("--point=session.registered");
  expect(startCmds).toContain("AGMUX_AGENT_PID=$PPID");
  expect(startCmds).not.toContain("--point=session.linked");
});
```

Adjust the import line at the top of `claude-plugin.test.ts` if needed so `PLUGIN_FILES` is in scope (it already imports from `plugin-files.ts`). Update any existing assertion in that file that expects `--point=session.linked` in SessionStart — it is intentionally removed in v1.2.0.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/adapters && bun test tests/adapters/claude.test.ts tests/adapters/claude-plugin.test.ts`
Expected: FAIL — `session.registered` hits normalize `default:` (empty events); `nativeIdFromEnv` undefined; plugin still v1.1.0 emitting `session.linked`.

- [ ] **Step 3: Register the source point + capability**

In `packages/adapters/src/adapters/claude/caps.ts`, add `"session.registered"` to the hook-command source `points` (first entry):

```typescript
    points: ["session.registered", "session.linked", "turn.started", "turn.ended", "input.required", "tool.used", "prompt.sent"],
```

Add the capability descriptor to `CLAUDE_CAPABILITIES` (first entry):

```typescript
  "session.registered": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "session.linked": { fulfil: "yes", source: "hook-command", liveness: "live" },
```

- [ ] **Step 4: Normalize the registered point**

In `packages/adapters/src/adapters/claude/normalize.ts`, add `cwd` to the stdin interface:

```typescript
interface ClaudeHookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  notification_type?: string;
  reason?: string;
}
```

Add a `case "session.registered":` to the switch (before `case "session.linked":`):

```typescript
    case "session.registered": {
      if (!raw.session_id) return { events: [] };
      const env = input.env ?? {};
      const pidNum = env.AGMUX_AGENT_PID != null ? Number(env.AGMUX_AGENT_PID) : NaN;
      return { events: [{
        kind: "session.registered",
        payload: {
          native_session_id: raw.session_id,
          agent_kind: "claude",
          pid: Number.isInteger(pidNum) ? pidNum : null,
          cwd: raw.cwd ?? env.PWD ?? null,
          tmux_session: null,           // Stage 2 (attach flip) enriches tmux coords
          tmux_window: null,
          tmux_pane: env.TMUX_PANE ?? null,
          profile: env.AGMUX_PROFILE ?? null,
          agent_version: env.CLAUDE_CODE_VERSION ?? null,
          parent: null,                 // lineage hint wired by the future spawn path (spec §5)
        },
      }] };
    }
```

- [ ] **Step 5: Wire `nativeIdFromEnv` on the adapter**

In `packages/adapters/src/adapters/claude/index.ts`, add to the `claudeAdapter` object (after `resumePlan`):

```typescript
  resumePlan: claudeResumePlan,
  nativeIdFromEnv: (env) => env.CLAUDE_CODE_SESSION_ID ?? null,
};
```

- [ ] **Step 6: Bump the plugin to v1.2.0 and rewire SessionStart**

In `packages/adapters/src/adapters/claude/plugin-files.ts`:

Change the version:

```typescript
export const PLUGIN_VERSION = "1.2.0";
```

Replace the `SessionStart` block of `HOOKS` with (emit `session.registered` carrying the agent pid via the hook shell's `$PPID`, drop the `session.linked` command, keep `--attach`):

```typescript
    SessionStart: [
      {
        // startup|resume|clear|compact: /clear and compaction rotate the native
        // session id mid-process; re-registering on each keeps the mapping current
        // (resolveIngest rule 3 = pid rotation). AGMUX_AGENT_PID=$PPID captures the
        // agent pid — the hook shell's parent IS the claude process (spec §8).
        matcher: "startup|resume|clear|compact",
        hooks: [
          { type: "command", async: true, command: `AGMUX_AGENT_PID=$PPID ${EMIT} --source=hook-command --point=session.registered` },
          { type: "command", async: true, command: `${EMIT} --attach` },
        ],
      },
    ],
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/adapters && bun test`
Expected: PASS (all adapter tests, including conformance and the updated claude/claude-plugin suites).

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/src/adapters/claude/ packages/adapters/tests/adapters/claude.test.ts packages/adapters/tests/adapters/claude-plugin.test.ts
git commit -m "claude: emit session.registered (v1.2.0 plugin), nativeIdFromEnv, drop session.linked hook"
```

---

## Task 15: CLI `emit` — native-identity emission

**Files:**
- Modify: `packages/cli/src/emit.ts`
- Test: `packages/cli/tests/emit.test.ts:1` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/emit.test.ts`:

```typescript
test("runEmit posts the NATIVE identity form when the adapter resolves a native id", async () => {
  const stateDir = tmp();
  const posted: any[] = [];
  const fakeFetch = (async (_url: string, init: any) => {
    posted.push(...JSON.parse(init.body));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;

  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { FAKE_NATIVE_ID: "nat-7", AGMUX_SESSION_ID: "claim-7", AGMUX_HUB_URL: "http://hub" },
    stdin: "{}", host: "h", stateDir, fetchImpl: fakeFetch,
  });

  expect(posted).toHaveLength(1);
  expect(posted[0].session_id).toBeUndefined();
  expect(posted[0].identity).toEqual({ agent_kind: "claude", native_session_id: "nat-7" });
  expect(posted[0].claim_session_id).toBe("claim-7");
});

test("runEmit queues under the native id when the hub POST fails", async () => {
  const stateDir = tmp();
  const failing = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { FAKE_NATIVE_ID: "nat-q", AGMUX_HUB_URL: "http://hub" }, // no AGMUX_SESSION_ID at all
    stdin: "{}", host: "h", stateDir, fetchImpl: failing,
  });
  expect(fs.existsSync(path.join(stateDir, "queue", "nat-q.jsonl"))).toBe(true);
});

test("runEmit drops when neither a native id nor AGMUX_SESSION_ID is available", async () => {
  const stateDir = tmp();
  let called = false;
  const fakeFetch = (async () => { called = true; return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(), env: {}, stdin: "{}", host: "h", stateDir, fetchImpl: fakeFetch,
  });
  expect(called).toBe(false);
});
```

(The three pre-existing `emit` tests must still pass: `fakeAdapter.nativeIdFromEnv` returns null unless `FAKE_NATIVE_ID` is set, so they exercise the canonical fallback path keyed by `AGMUX_SESSION_ID`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test tests/emit.test.ts`
Expected: FAIL — the new native test sees `session_id: "claim-7"` (current code always stamps canonical); the native-only queue test drops (current guard requires `AGMUX_SESSION_ID`).

- [ ] **Step 3: Rewrite `runEmit`'s identity + stamping**

In `packages/cli/src/emit.ts`, update the imports:

```typescript
import {
  stampIngestEvents, buildAttachedEvent, loadRecord,
  type Registry, type CanonicalEvent, type ManifestPoint,
} from "@agmux/adapters";
import type { AgentKind, CapabilitySourceType, IngestEnvelope } from "@agmux/protocol";
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV } from "@agmux/protocol";
```

Replace the body of `runEmit` (lines 56-96) with:

```typescript
export async function runEmit(argv: string[], deps: EmitDeps): Promise<void> {
  try {
    const a = parseEmitArgs(argv);
    if (!a.from) return;
    const adapter = deps.registry.lookup(a.from as AgentKind);
    if (!adapter) return;

    // Identity (spec §2): the agent's OWN native id (from its hook env), plus the
    // optional wrapper bridge claim (AGMUX_SESSION_ID). Native id is preferred;
    // claim is the fallback / bridge. With neither, we cannot name a session — drop.
    const nativeId = adapter.nativeIdFromEnv?.(deps.env) ?? null;
    const claimId = deps.env[AGMUX_SESSION_ID_ENV] ?? null;
    if (!nativeId && !claimId) return;

    let events: CanonicalEvent[];
    if (a.attach) {
      const rec = loadRecord(deps.stateDir, a.from, a.profile);
      if (!rec) return;
      events = [buildAttachedEvent({
        agentKind: a.from as AgentKind, profile: rec.profile,
        adapterVersion: rec.adapterVersion, capabilities: rec.capabilities,
      })];
    } else {
      if (!a.point || !a.source) return;
      const cursor = a.cursorFile && fs.existsSync(a.cursorFile) ? fs.readFileSync(a.cursorFile, "utf8") : null;
      const out = adapter.normalize({
        point: a.point, source: a.source, raw: parseRaw(deps.stdin), cursor,
        target: { agentKind: a.from as AgentKind, profile: a.profile },
        env: deps.env,
      });
      events = out.events;
      if (a.cursorFile && out.cursor != null) {
        try { fs.writeFileSync(a.cursorFile, out.cursor); } catch { /* best-effort */ }
      }
    }
    if (events.length === 0) return;

    const stamped = stampIngestEvents(events, {
      agentKind: a.from as AgentKind, nativeId, claimId, host: deps.host, now: deps.now, newId: deps.newId,
    });
    await postOrQueue(stamped, {
      hubUrl: deps.env[AGMUX_HUB_URL_ENV], stateDir: deps.stateDir,
      queueKey: nativeId ?? claimId!, // one of the two is set (guard above)
      fetchImpl: deps.fetchImpl ?? fetch, timeoutMs: deps.timeoutMs ?? 1500,
    });
  } catch {
    // Swallow everything: a telemetry failure must never break the agent.
  }
}
```

Update `postOrQueue`'s signature and body to take `queueKey` and accept `IngestEnvelope[]`:

```typescript
async function postOrQueue(events: IngestEnvelope[], o: {
  hubUrl: string | undefined; stateDir: string; queueKey: string;
  fetchImpl: typeof fetch; timeoutMs: number;
}): Promise<void> {
  if (o.hubUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), o.timeoutMs);
      const res = await o.fetchImpl(`${o.hubUrl}/ingest`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events), signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status < 500 && res.status !== 0) return; // 2xx/4xx = delivered or unrecoverable
    } catch { /* fall through to queue */ }
  }
  const queueDir = path.join(o.stateDir, "queue");
  fs.mkdirSync(queueDir, { recursive: true });
  const qf = path.join(queueDir, `${o.queueKey}.jsonl`);
  fs.appendFileSync(qf, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test tests/emit.test.ts`
Expected: PASS (3 existing canonical-fallback tests + 3 new native tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/emit.ts packages/cli/tests/emit.test.ts
git commit -m "cli: emit builds native identity from agent env, claim bridge fallback"
```

---

## Task 16: End-to-end native registration + foundation doc annotation

**Files:**
- Test: `packages/hub/tests/native-e2e.test.ts` (Create)
- Modify: `docs/agmux-foundation.md`

- [ ] **Step 1: Write the end-to-end test**

Create `packages/hub/tests/native-e2e.test.ts` — drives the real stamping + hub + store path (registration → reopen on re-register → pid-sweep lost), proving the pieces compose:

```typescript
import { test, expect } from "bun:test";
import { Store } from "@agmux/store";
import { createServer } from "../src/server.ts";
import { sweepNativeLiveness } from "../src/liveness.ts";
import { stampIngestEvents } from "@agmux/adapters";

function makeServer() {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  return { store, server, url: `http://${server.hostname}:${server.port}` };
}
async function post(url: string, body: unknown) {
  return fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("native session lifecycle: register → mint, re-register dead session → reopen, pid-sweep → lost", async () => {
  const { store, server, url } = makeServer();

  // 1. A native session.registered (as emit would stamp it) mints a session.
  const [reg] = stampIngestEvents(
    [{ kind: "session.registered", payload: {
        native_session_id: "nat-e2e", agent_kind: "claude", pid: 999999, cwd: "/tmp",
        tmux_session: null, tmux_window: null, tmux_pane: "%1", profile: null, agent_version: null, parent: null }, dedup_key: null }],
    { agentKind: "claude", nativeId: "nat-e2e", claimId: null, host: "macbook.local" },
  );
  await post(url, reg);
  const minted = store.listSessions({}).find((s) => s.native_session_id === "nat-e2e")!;
  expect(minted.origin).toBe("native");
  const sid = minted.session_id;

  // 2. pid 999999 is (almost certainly) dead → sweep marks it lost.
  const lost = sweepNativeLiveness(store, { host: "macbook.local", isAlive: () => false });
  expect(lost).toBe(1);
  expect(store.getSession(sid)!.status).toBe("lost");

  // 3. Re-registering the SAME native id reopens the same canonical session (rule 1).
  await post(url, reg);
  expect(store.getSession(sid)!.status).toBe("idle");
  // Still exactly one session for this native id — no duplicate minted.
  expect(store.listSessions({}).filter((s) => s.native_session_id === "nat-e2e")).toHaveLength(1);

  server.stop();
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/hub && bun test tests/native-e2e.test.ts`
Expected: PASS. (This is an integration test over already-implemented pieces; it should pass immediately. If it fails, the failure pinpoints which earlier task regressed.)

- [ ] **Step 3: Annotate the superseded foundation sections**

In `docs/agmux-foundation.md`, add a note at the top of §4 (capture model) and §5 (identity). At the start of each section's body, insert:

```markdown
> **Superseded (2026-06-08):** The wrapper-primary capture/identity stance below is
> superseded by the native-first design — see
> [`docs/superpowers/specs/2026-06-05-native-first-design.md`](superpowers/specs/2026-06-05-native-first-design.md).
> Sessions now self-register from their own hooks; the hub resolves native identity
> to a canonical session at ingest. The wrapper remains an opt-in launcher.
```

(Locate the §4 and §5 headings by reading the file first; match the existing heading style — they may be `## 4. ...` / `## 5. ...` or similar.)

- [ ] **Step 4: Run the full suite across all packages**

Run from the repo root: `bun test`
Expected: PASS across `protocol`, `store`, `hub`, `adapters`, `cli`. Also run typechecks:
Run: `bun run -F '*' typecheck` (or per package: `cd packages/<pkg> && bun run typecheck`)
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/tests/native-e2e.test.ts docs/agmux-foundation.md
git commit -m "test: native registration e2e; annotate foundation §4/§5 as superseded"
```

---

## Self-review notes (for the executor)

- **Backward compatibility is the safety net.** Every change is additive: canonical-form `session_id` events validate, resolve, and store exactly as before (Task 8 rule-0 pass-through; Task 10/12 accept both forms). The wrapper, `run`, `attach`, and `relaunch` are untouched in Stage 1.
- **The claim race (spec §8)** is handled by the ordering guarantee (wrapper posts `session.started` before exec; the agent hook can't fire until after exec) + rule-2's "target must exist & be live" requirement. The reverse-race duplicate is the accepted v1 edge — do not add speculative merge logic.
- **`pid` capture** depends on Claude running hooks in a shell whose parent is the agent. If smoke-testing shows `pid` is wrong/null, that only degrades pid-sweep for that row (it stays in its last event-driven status); it never corrupts identity. Verify the `$PPID` hop during smoke test before trusting native liveness.
- **Do not remove the nesting guard** or demote the projection freeze — those are Stage 2.
- After Task 16, rebuild the compiled binaries used by smoke tests (`agmux`, `agmux-hub`, `agmux-wrap`) and reinstall the Claude plugin (`agmux install claude`) so SessionStart emits v1.2.0 `session.registered`.
