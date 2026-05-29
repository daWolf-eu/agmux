# Adapter Events — Phase 1 (Protocol + Store) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the protocol + store to ingest and act on the new adapter-emitted event kinds — driving `running`/`idle`/`waiting` status, accumulating normalized token usage, recording per-session capabilities, and deduplicating replayable source events — with no concrete provider and no new package.

**Architecture:** Additive only. New event-kind payload types + lenient validators in `@agmux/protocol`; a `dedup_key` envelope field; a v2 migration adding `session_usage` + an `events.dedup_key` unique partial index + a `sessions.adapter_capabilities` column; new projection handlers implementing the guarded status state machine and the usage aggregate; dedup-aware `append`. The hub ingests already-canonical events; this phase makes the projection *act* on the kinds it currently stores raw.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, `bun test`. Bun workspaces monorepo (`packages/*`).

**Spec:** [`docs/superpowers/specs/2026-05-29-adapters-framework-design.md`](../specs/2026-05-29-adapters-framework-design.md) §3 (event contract), §4.4 (dedup), §5 (projection/status/usage), §6.2 (capabilities at session start).

**Out of this phase (Phase 2):** `@agmux/adapters` package, the `Adapter` interface, `agmux emit`, `agmux adapter` verbs, wrapper `AGMUX_PROFILE` injection, attach resume-plan. Phase 1 only makes the hub-side correct and testable.

---

## File Structure

**`@agmux/protocol`**
- `src/telemetry.ts` *(create)* — wire types shared with Phase 2: `UsageReport`, `CapabilitySourceType`, `CapabilityFulfilment`, `CapabilityDescriptor`, `CapabilityMap`.
- `src/events.ts` *(modify)* — add `dedup_key?` to `EventEnvelope`; add the 9 new payload interfaces + typed events + `EVENT_KINDS_ADAPTER`; extend `KnownEvent`.
- `src/env.ts` *(modify)* — add `AGMUX_PROFILE_ENV` constant (consumed in Phase 2; defined here so the contract lives in one place).
- `src/validators.ts` *(modify)* — lenient validation for the new kinds.
- `src/index.ts` *(modify)* — re-export `telemetry.ts`.

**`@agmux/store`**
- `src/schema.ts` *(modify)* — add `SCHEMA_V2` SQL string.
- `src/migrations.ts` *(modify)* — append migration `version: 2`.
- `src/project.ts` *(modify)* — handlers for the new kinds: status state machine + usage upsert + capabilities.
- `src/queries.ts` *(modify)* — `getSessionUsage`.
- `src/index.ts` *(modify)* — dedup-aware `append`; expose `getSessionUsage`; reset `session_usage` in `rebuildProjections`.

**`@agmux/hub`**
- `src/server.ts` *(modify)* — include `usage` in the `GET /sessions/:id` response.

**Tests**
- `packages/protocol/tests/validators.test.ts` *(modify)* — cases for new kinds.
- `packages/store/tests/migrations.test.ts` *(modify)* — v2 objects exist.
- `packages/store/tests/project.test.ts` *(modify)* — fix the `unknown-kind` test; add state-machine + capability tests.
- `packages/store/tests/usage.test.ts` *(create)* — usage upsert (delta vs cumulative).
- `packages/store/tests/dedup.test.ts` *(create)* — dedup-aware append.
- `packages/hub/tests/server.test.ts` *(modify)* — usage in inspect response.

---

## Task 1: Protocol — shared telemetry/capability wire types

**Files:**
- Create: `packages/protocol/src/telemetry.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Create the telemetry wire types**

Create `packages/protocol/src/telemetry.ts`:

```typescript
// Wire types shared between the store/hub (Phase 1) and the adapters package
// (Phase 2). Kept in @agmux/protocol because they appear in event payloads
// (usage.reported, session.adapter_attached) that cross the ingest boundary.

export type CapabilitySourceType =
  | "hook-command"
  | "transcript-delta"
  | "exec-json-stream"
  | "transcript-tail"
  | "mcp"
  | "manual-command";

export type CapabilityFulfilment = "yes" | "partial" | "no";

export interface CapabilityDescriptor {
  fulfil: CapabilityFulfilment;
  source?: CapabilitySourceType;
  liveness?: "live" | "backfilled";
  minAgentVersion?: string;
  runtimeGate?: "hook-trust" | "none";
}

// Keyed by hook-point name at its finest grain (e.g. "turn.started",
// "input.permission"). A missing key means "not declared" == not fulfilled.
export type CapabilityMap = Record<string, CapabilityDescriptor>;

// Normalized usage. Every figure nullable; an adapter fills what its provider
// exposes. Superset of common first-party fields so normalization never erases
// data a provider already gives us. Additive over time (all nullable).
export interface UsageReport {
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  total_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  model_context_window?: number | null;
  rate_limit?: unknown;          // provider-shaped; stored as JSON
  cost_usd?: number | null;
  turn_id?: string | null;
  cumulative: boolean;           // false = per-turn delta, true = session total
  as_of?: string | null;         // provider timestamp the figures are valid at
  source: string;                // which CapabilitySource produced this
}
```

- [ ] **Step 2: Re-export from the protocol barrel**

In `packages/protocol/src/index.ts`, add the line after the existing exports:

```typescript
export * from "./telemetry.ts";
```

Resulting file:

```typescript
export * from "./env.ts";
export * from "./session.ts";
export * from "./events.ts";
export * from "./validators.ts";
export * from "./telemetry.ts";
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @agmux/protocol typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/telemetry.ts packages/protocol/src/index.ts
git commit -m "protocol: add telemetry + capability wire types"
```

---

## Task 2: Protocol — `dedup_key` envelope field + new event payloads

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Modify: `packages/protocol/src/env.ts`

- [ ] **Step 1: Add `dedup_key` to the envelope and the new event kinds**

In `packages/protocol/src/events.ts`, change the imports at the top to also pull the telemetry types:

```typescript
import type { AgentKind } from "./session.ts";
import type { UsageReport, CapabilityMap } from "./telemetry.ts";
```

Add `dedup_key` to `EventEnvelope` (after `payload`):

```typescript
export interface EventEnvelope<P = unknown> {
  event_id: string;     // ULID
  ts: string;           // ISO-8601 UTC, ms precision
  session_id: string;   // UUIDv7
  kind: string;         // not narrowed — unknown kinds permitted
  version: number;      // per-kind schema version (default 1)
  host: string;         // hostname
  payload: P;
  dedup_key?: string | null; // optional source-idempotency key (§4.4)
}
```

Add the adapter event-kind list after `EVENT_KINDS_MVP`:

```typescript
export const EVENT_KINDS_ADAPTER = [
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

- [ ] **Step 2: Add the payload interfaces**

In the same file, after the existing `SessionEndedPayload` interface, add:

```typescript
export interface SessionLinkedPayload {
  native_session_id: string;
}

export interface TurnStartedPayload {
  turn_id?: string | null;
  prompt_chars?: number | null;
}

export interface TurnEndedPayload {
  turn_id?: string | null;
  reason?: string | null;
}

export interface InputRequiredPayload {
  kind: "prompt" | "permission" | "confirm";
  detail?: string | null;
}

export type InputReceivedPayload = Record<string, never>;

export interface ToolUsedPayload {
  tool: string;
  ok?: boolean | null;
  detail?: string | null;
}

export interface PromptSentPayload {
  chars?: number | null;
  redacted: true;
}

export type UsageReportedPayload = UsageReport;

export interface AdapterAttachedPayload {
  agent_kind: AgentKind;
  profile: string | null;
  adapter_version: string;
  capabilities: CapabilityMap;
}
```

- [ ] **Step 3: Add typed events + extend the `KnownEvent` union**

At the bottom of `events.ts`, before `export type KnownEvent`, add the typed events:

```typescript
export type SessionLinkedEvent = EventEnvelope<SessionLinkedPayload> & { kind: "session.linked" };
export type TurnStartedEvent = EventEnvelope<TurnStartedPayload> & { kind: "turn.started" };
export type TurnEndedEvent = EventEnvelope<TurnEndedPayload> & { kind: "turn.ended" };
export type InputRequiredEvent = EventEnvelope<InputRequiredPayload> & { kind: "input.required" };
export type InputReceivedEvent = EventEnvelope<InputReceivedPayload> & { kind: "input.received" };
export type UsageReportedEvent = EventEnvelope<UsageReportedPayload> & { kind: "usage.reported" };
export type ToolUsedEvent = EventEnvelope<ToolUsedPayload> & { kind: "tool.used" };
export type PromptSentEvent = EventEnvelope<PromptSentPayload> & { kind: "prompt.sent" };
export type AdapterAttachedEvent = EventEnvelope<AdapterAttachedPayload> & { kind: "session.adapter_attached" };
```

Then extend the existing `KnownEvent` union to add the new members:

```typescript
export type KnownEvent =
  | SessionStartedEvent
  | SessionHeartbeatEvent
  | SessionResumedEvent
  | SessionEndedEvent
  | SessionLinkedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | InputRequiredEvent
  | InputReceivedEvent
  | UsageReportedEvent
  | ToolUsedEvent
  | PromptSentEvent
  | AdapterAttachedEvent;
```

- [ ] **Step 4: Add the `AGMUX_PROFILE_ENV` constant**

In `packages/protocol/src/env.ts`, add after `AGMUX_TMUX_SESSION_ENV`:

```typescript
export const AGMUX_PROFILE_ENV = "AGMUX_PROFILE";
```

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @agmux/protocol typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/env.ts
git commit -m "protocol: add adapter event kinds, payloads, and dedup_key envelope field"
```

---

## Task 3: Protocol — lenient validators for the new kinds

**Files:**
- Modify: `packages/protocol/src/validators.ts`
- Test: `packages/protocol/tests/validators.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/tests/validators.test.ts`:

```typescript
test("validateKnownPayload accepts session.linked with native_session_id", () => {
  expect(validateKnownPayload("session.linked", { native_session_id: "abc" })).toEqual({ ok: true });
});

test("validateKnownPayload rejects session.linked missing native_session_id", () => {
  const r = validateKnownPayload("session.linked", {});
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/native_session_id/);
});

test("validateKnownPayload accepts turn.started with empty payload", () => {
  expect(validateKnownPayload("turn.started", {})).toEqual({ ok: true });
});

test("validateKnownPayload validates input.required kind enum", () => {
  expect(validateKnownPayload("input.required", { kind: "permission" })).toEqual({ ok: true });
  const r = validateKnownPayload("input.required", { kind: "bogus" });
  expect(r.ok).toBe(false);
});

test("validateKnownPayload requires usage.reported cumulative+source", () => {
  expect(validateKnownPayload("usage.reported", { cumulative: false, source: "transcript-delta", input_tokens: 10 })).toEqual({ ok: true });
  const r = validateKnownPayload("usage.reported", { input_tokens: 10 });
  expect(r.ok).toBe(false);
});

test("validateKnownPayload validates session.adapter_attached", () => {
  expect(validateKnownPayload("session.adapter_attached", {
    agent_kind: "codex", profile: null, adapter_version: "1", capabilities: {},
  })).toEqual({ ok: true });
  const r = validateKnownPayload("session.adapter_attached", {
    agent_kind: "nope", profile: null, adapter_version: "1", capabilities: {},
  });
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/protocol/tests/validators.test.ts`
Expected: the new tests for rejection cases FAIL (current default returns `{ ok: true }` for all unknown kinds, so the "rejects" assertions fail).

- [ ] **Step 3: Add the validator cases**

In `packages/protocol/src/validators.ts`, inside the `switch (kind)` in `validateKnownPayload`, add these cases **before** the `default:` case:

```typescript
    case "session.linked": {
      if (!isStringNonEmpty(payload.native_session_id))
        return { ok: false, error: "session.linked: native_session_id missing" };
      return { ok: true };
    }
    case "turn.started":
    case "turn.ended":
    case "input.received":
    case "prompt.sent":
      // Log/state events with no load-bearing required fields. Payload-is-object
      // already checked above; anything else is optional/best-effort.
      return { ok: true };
    case "input.required": {
      if (payload.kind !== "prompt" && payload.kind !== "permission" && payload.kind !== "confirm")
        return { ok: false, error: "input.required: kind must be prompt|permission|confirm" };
      return { ok: true };
    }
    case "usage.reported": {
      if (typeof payload.cumulative !== "boolean")
        return { ok: false, error: "usage.reported: cumulative not boolean" };
      if (!isStringNonEmpty(payload.source))
        return { ok: false, error: "usage.reported: source missing" };
      return { ok: true };
    }
    case "tool.used": {
      if (!isStringNonEmpty(payload.tool))
        return { ok: false, error: "tool.used: tool missing" };
      return { ok: true };
    }
    case "session.adapter_attached": {
      if (payload.agent_kind !== "claude" && payload.agent_kind !== "codex")
        return { ok: false, error: "session.adapter_attached: agent_kind invalid" };
      if (!isStringNonEmpty(payload.adapter_version))
        return { ok: false, error: "session.adapter_attached: adapter_version missing" };
      if (!isPlainObject(payload.capabilities))
        return { ok: false, error: "session.adapter_attached: capabilities not object" };
      return { ok: true };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/protocol/tests/validators.test.ts`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/validators.ts packages/protocol/tests/validators.test.ts
git commit -m "protocol: validate adapter event payloads (lenient)"
```

---

## Task 4: Store — v2 migration (session_usage, dedup_key, capabilities column)

**Files:**
- Modify: `packages/store/src/schema.ts`
- Modify: `packages/store/src/migrations.ts`
- Test: `packages/store/tests/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/store/tests/migrations.test.ts`:

```typescript
test("migration v2 creates session_usage, dedup_key column, and adapter_capabilities column", () => {
  const db = new Database(":memory:");
  runMigrations(db);

  const usageCols = db.query<any, []>(`PRAGMA table_info(session_usage)`).all();
  expect(usageCols.length).toBeGreaterThan(0);
  const usageNames = usageCols.map((c: any) => c.name);
  expect(usageNames).toContain("input_tokens");
  expect(usageNames).toContain("reasoning_output_tokens");
  expect(usageNames).toContain("turn_count");

  const eventCols = db.query<any, []>(`PRAGMA table_info(events)`).all().map((c: any) => c.name);
  expect(eventCols).toContain("dedup_key");

  const sessionCols = db.query<any, []>(`PRAGMA table_info(sessions)`).all().map((c: any) => c.name);
  expect(sessionCols).toContain("adapter_capabilities");

  const ver = db.query<{ value: string }, []>(`SELECT value FROM _meta WHERE key='schema_version'`).get();
  expect(Number(ver!.value)).toBe(2);
});
```

If `migrations.test.ts` does not already import `Database`, add at the top:

```typescript
import { Database } from "bun:sqlite";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/store/tests/migrations.test.ts`
Expected: FAIL — `session_usage` has no columns / `schema_version` is `1`.

- [ ] **Step 3: Add the v2 schema string**

In `packages/store/src/schema.ts`, append:

```typescript
export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS session_usage (
  session_id              TEXT PRIMARY KEY,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd                REAL NOT NULL DEFAULT 0,
  last_model              TEXT,
  last_rate_limit         TEXT,
  turn_count              INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE events ADD COLUMN dedup_key TEXT;
-- Partial unique index: many NULLs allowed (the common case), but a non-null
-- dedup_key may appear at most once — source idempotency (§4.4).
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(dedup_key) WHERE dedup_key IS NOT NULL;

ALTER TABLE sessions ADD COLUMN adapter_capabilities TEXT;
`;
```

- [ ] **Step 4: Register migration v2**

In `packages/store/src/migrations.ts`, import `SCHEMA_V2` and append to the `MIGRATIONS` array:

```typescript
import { SCHEMA_V1, SCHEMA_V2 } from "./schema.ts";
```

```typescript
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(SCHEMA_V2);
    },
  },
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/store/tests/migrations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/schema.ts packages/store/src/migrations.ts packages/store/tests/migrations.test.ts
git commit -m "store: v2 migration — session_usage, events.dedup_key, sessions.adapter_capabilities"
```

---

## Task 5: Store — dedup-aware `append`

**Files:**
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/dedup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/dedup.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

const sid = "0190a3e0-0000-7000-8000-000000000000";

function startedEvent() {
  return {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
    ts: "2026-05-28T12:00:00.000Z",
    session_id: sid, kind: "session.started", version: 1, host: "h",
    payload: {
      agent_kind: "codex", profile: null, command: "codex", args: [],
      env_overrides: {}, cwd: "/tmp", pid: 1, tmux_session: null,
      tmux_window: null, tmux_pane: null, project: null,
    },
  } as any;
}

function usageEvent(eventId: string, dedupKey: string | null) {
  return {
    event_id: eventId,
    ts: "2026-05-28T12:01:00.000Z",
    session_id: sid, kind: "usage.reported", version: 1, host: "h",
    dedup_key: dedupKey,
    payload: { cumulative: false, source: "transcript-delta", input_tokens: 100 },
  } as any;
}

test("append skips a second event with the same dedup_key", () => {
  const store = Store.openInMemory();
  store.append(startedEvent());
  expect(store.append(usageEvent("01HZ7P0K8WVQH8WGS8X9DC9001", "codex:t:42"))).toBe(true);
  expect(store.append(usageEvent("01HZ7P0K8WVQH8WGS8X9DC9002", "codex:t:42"))).toBe(false);
  const usage = store.getSessionUsage(sid);
  expect(usage!.input_tokens).toBe(100); // applied once, not twice
  store.close();
});

test("append allows multiple events with null dedup_key", () => {
  const store = Store.openInMemory();
  store.append(startedEvent());
  expect(store.append(usageEvent("01HZ7P0K8WVQH8WGS8X9DC9003", null))).toBe(true);
  expect(store.append(usageEvent("01HZ7P0K8WVQH8WGS8X9DC9004", null))).toBe(true);
  const usage = store.getSessionUsage(sid);
  expect(usage!.input_tokens).toBe(200); // both applied
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/store/tests/dedup.test.ts`
Expected: FAIL — `getSessionUsage` does not exist yet, and `append` does not persist `dedup_key`. (This task adds the `dedup_key` write + catch; `getSessionUsage` + usage upsert land in Tasks 6–7. Expect compile/runtime failure here; the test goes green by end of Task 7.)

- [ ] **Step 3: Persist `dedup_key` and treat any UNIQUE violation as a duplicate**

In `packages/store/src/index.ts`, change the `INSERT` in `append` to include `dedup_key`, and broaden the catch to any UNIQUE violation:

```typescript
  append(ev: EventEnvelope): boolean {
    const tx = this.db.transaction(() => {
      try {
        this.db.query(`
          INSERT INTO events (event_id, ts, session_id, kind, version, payload, host, dedup_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ev.event_id, ev.ts, ev.session_id, ev.kind, ev.version,
          JSON.stringify(ev.payload), ev.host, ev.dedup_key ?? null,
        );
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // Either a replayed event_id (transport retry) or a repeated dedup_key
        // (source observed the same fact twice) — both mean "already have it".
        if (msg.includes("UNIQUE")) return false;
        throw e;
      }
      applyEventToProjection(this.db, ev);
      return true;
    });
    return tx();
  }
```

- [ ] **Step 4: Leave the test red for now**

Run: `bun test packages/store/tests/dedup.test.ts`
Expected: still FAIL on `getSessionUsage`/usage totals (added in Tasks 6–7). The `dedup_key` write + catch are done.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/index.ts packages/store/tests/dedup.test.ts
git commit -m "store: persist dedup_key and skip duplicate UNIQUE violations on append"
```

---

## Task 6: Store — `getSessionUsage` query

**Files:**
- Modify: `packages/store/src/queries.ts`
- Modify: `packages/store/src/index.ts`

- [ ] **Step 1: Add the query + its row type**

Append to `packages/store/src/queries.ts`:

```typescript
export interface SessionUsageRow {
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  last_model: string | null;
  last_rate_limit: unknown;     // decoded from JSON
  turn_count: number;
}

export function getSessionUsage(db: Database, sid: string): SessionUsageRow | null {
  const raw = db.query<any, [string]>(`SELECT * FROM session_usage WHERE session_id = ?`).get(sid);
  if (!raw) return null;
  return {
    session_id: raw.session_id,
    input_tokens: raw.input_tokens,
    output_tokens: raw.output_tokens,
    reasoning_output_tokens: raw.reasoning_output_tokens,
    cache_read_tokens: raw.cache_read_tokens,
    cache_write_tokens: raw.cache_write_tokens,
    cost_usd: raw.cost_usd,
    last_model: raw.last_model,
    last_rate_limit: raw.last_rate_limit == null ? null : JSON.parse(raw.last_rate_limit),
    turn_count: raw.turn_count,
  };
}
```

- [ ] **Step 2: Expose it on the Store**

In `packages/store/src/index.ts`, extend the import from `./queries.ts` to include `getSessionUsage` and its row type:

```typescript
import { getSessionRaw, listSessions, listEvents, getSessionUsage, type ListSessionsOpts, type ListEventsOpts, type SessionUsageRow } from "./queries.ts";
```

Add the method (after `listEvents`):

```typescript
  getSessionUsage(sid: string): SessionUsageRow | null {
    return getSessionUsage(this.db, sid);
  }
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @agmux/store typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/store/src/queries.ts packages/store/src/index.ts
git commit -m "store: getSessionUsage query"
```

---

## Task 7: Store — projection handlers (status state machine, usage, capabilities)

**Files:**
- Modify: `packages/store/src/project.ts`
- Modify: `packages/store/src/index.ts` (reset `session_usage` in `rebuildProjections`)
- Test: `packages/store/tests/project.test.ts` (fix + add)
- Test: `packages/store/tests/usage.test.ts` (create)

- [ ] **Step 1: Fix the existing unknown-kind test (it used `turn.started`)**

In `packages/store/tests/project.test.ts`, the test `"unknown event kinds do not crash and do not update the projection"` uses `kind: "turn.started"`, which is no longer unknown. Change that event's `kind` to a genuinely unknown kind:

```typescript
    session_id: sid, kind: "future.unknown.kind", version: 1, host: "macbook.local",
    payload: { anything: 1 },
```

- [ ] **Step 2: Write the failing state-machine + capability tests**

Append to `packages/store/tests/project.test.ts` (the file already defines `freshDb`, `sid`, and `startedEvent`):

```typescript
function ev(kind: string, ts: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    ts, session_id: sid, kind, version: 1, host: "h", payload, ...extra,
  } as any;
}

test("turn.started -> running, turn.ended -> idle", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("turn.started", "2026-05-28T12:01:00.000Z", {}));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("running");
  applyEventToProjection(db, ev("turn.ended", "2026-05-28T12:02:00.000Z", { reason: "done" }));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("idle");
});

test("input.required -> waiting, input.received -> running", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("input.required", "2026-05-28T12:01:00.000Z", { kind: "permission" }));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("waiting");
  applyEventToProjection(db, ev("input.received", "2026-05-28T12:01:30.000Z", {}));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("running");
});

test("live transition on an ended row is ignored (no resurrection)", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("session.ended", "2026-05-28T12:05:00.000Z", { exit_code: 0, signal: null, reason: "normal" }));
  applyEventToProjection(db, ev("turn.started", "2026-05-28T12:06:00.000Z", {}));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("ended");
});

test("session.linked sets native_session_id", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("session.linked", "2026-05-28T12:01:00.000Z", { native_session_id: "codex-xyz" }));
  expect(db.query<any, []>(`SELECT native_session_id FROM sessions WHERE session_id='${sid}'`).get().native_session_id).toBe("codex-xyz");
});

test("session.adapter_attached records capabilities JSON", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  const caps = { "turn.started": { fulfil: "yes", source: "hook-command" } };
  applyEventToProjection(db, ev("session.adapter_attached", "2026-05-28T12:00:30.000Z", {
    agent_kind: "codex", profile: null, adapter_version: "1", capabilities: caps,
  }));
  const raw = db.query<any, []>(`SELECT adapter_capabilities FROM sessions WHERE session_id='${sid}'`).get();
  expect(JSON.parse(raw.adapter_capabilities)).toEqual(caps);
});

test("turn.started bumps session_usage.turn_count and creates the row", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("turn.started", "2026-05-28T12:01:00.000Z", {}));
  const u = db.query<any, []>(`SELECT turn_count FROM session_usage WHERE session_id='${sid}'`).get();
  expect(u.turn_count).toBe(1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/store/tests/project.test.ts`
Expected: the new tests FAIL (no handlers yet); the fixed unknown-kind test PASSES.

- [ ] **Step 4: Implement the handlers**

In `packages/store/src/project.ts`, add the new `case`s to the `switch` in `applyEventToProjection`, before `default:`:

```typescript
    case "session.linked":
      applyLinked(db, ev);
      return;
    case "turn.started":
      applyLiveStatus(db, ev, "running");
      bumpTurnCount(db, ev);
      return;
    case "turn.ended":
      applyLiveStatus(db, ev, "idle");
      return;
    case "input.required":
      applyLiveStatus(db, ev, "waiting");
      return;
    case "input.received":
      applyLiveStatus(db, ev, "running");
      return;
    case "usage.reported":
      applyUsage(db, ev);
      return;
    case "session.adapter_attached":
      applyAdapterAttached(db, ev);
      return;
    // tool.used / prompt.sent are known but log-only: no projection effect.
```

Add the handler functions at the bottom of the file:

```typescript
// Live status transitions are guarded: they apply only to a non-ended row, so
// an out-of-order or stray adapter event can never resurrect a dead session.
// (`lost` is computed at read time in lost.ts, not stored, so the stored status
// here is only idle/running/waiting/ended; excluding 'ended' == "still live".)
function applyLiveStatus(db: Database, ev: EventEnvelope, status: "running" | "idle" | "waiting"): void {
  db.query(`
    UPDATE sessions SET status = ?
     WHERE session_id = ? AND status NOT IN ('ended')
  `).run(status, ev.session_id);
}

function applyLinked(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`UPDATE sessions SET native_session_id = ? WHERE session_id = ?`)
    .run(p.native_session_id, ev.session_id);
}

function applyAdapterAttached(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`UPDATE sessions SET adapter_capabilities = ? WHERE session_id = ?`)
    .run(JSON.stringify(p.capabilities ?? {}), ev.session_id);
}

function ensureUsageRow(db: Database, sessionId: string): void {
  db.query(`INSERT INTO session_usage (session_id) VALUES (?) ON CONFLICT(session_id) DO NOTHING`)
    .run(sessionId);
}

function bumpTurnCount(db: Database, ev: EventEnvelope): void {
  ensureUsageRow(db, ev.session_id);
  db.query(`UPDATE session_usage SET turn_count = turn_count + 1 WHERE session_id = ?`)
    .run(ev.session_id);
}

function n(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

function applyUsage(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  ensureUsageRow(db, ev.session_id);
  const rl = p.rate_limit == null ? null : JSON.stringify(p.rate_limit);
  if (p.cumulative === true) {
    // Provider already summed: replace token totals with the reported figures.
    db.query(`
      UPDATE session_usage SET
        input_tokens = ?, output_tokens = ?, reasoning_output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?,
        last_model = COALESCE(?, last_model),
        last_rate_limit = COALESCE(?, last_rate_limit)
      WHERE session_id = ?
    `).run(
      n(p.input_tokens), n(p.output_tokens), n(p.reasoning_output_tokens),
      n(p.cache_read_tokens), n(p.cache_write_tokens), n(p.cost_usd),
      p.model ?? null, rl, ev.session_id,
    );
  } else {
    // Per-turn delta: accumulate.
    db.query(`
      UPDATE session_usage SET
        input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
        reasoning_output_tokens = reasoning_output_tokens + ?,
        cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?,
        cost_usd = cost_usd + ?,
        last_model = COALESCE(?, last_model),
        last_rate_limit = COALESCE(?, last_rate_limit)
      WHERE session_id = ?
    `).run(
      n(p.input_tokens), n(p.output_tokens), n(p.reasoning_output_tokens),
      n(p.cache_read_tokens), n(p.cache_write_tokens), n(p.cost_usd),
      p.model ?? null, rl, ev.session_id,
    );
  }
}
```

- [ ] **Step 5: Reset `session_usage` on projection rebuild**

In `packages/store/src/index.ts`, in `rebuildProjections`, add a `DELETE FROM session_usage` next to the existing `DELETE FROM sessions`:

```typescript
      this.db.exec(`DELETE FROM sessions`);
      this.db.exec(`DELETE FROM session_usage`);
```

- [ ] **Step 6: Run the project tests to verify they pass**

Run: `bun test packages/store/tests/project.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Write the usage upsert test**

Create `packages/store/tests/usage.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { getSessionUsage } from "../src/queries.ts";

const sid = "0190a3e0-0000-7000-8000-000000000000";

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
    ts: "2026-05-28T12:00:00.000Z",
    session_id: sid, kind: "session.started", version: 1, host: "h",
    payload: {
      agent_kind: "codex", profile: null, command: "codex", args: [],
      env_overrides: {}, cwd: "/tmp", pid: 1, tmux_session: null,
      tmux_window: null, tmux_pane: null, project: null,
    },
  } as any);
  return db;
}

function usage(ts: string, payload: Record<string, unknown>) {
  return {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    ts, session_id: sid, kind: "usage.reported", version: 1, host: "h", payload,
  } as any;
}

test("delta usage accumulates across reports", () => {
  const db = freshDb();
  applyEventToProjection(db, usage("2026-05-28T12:01:00.000Z", { cumulative: false, source: "s", input_tokens: 100, output_tokens: 10 }));
  applyEventToProjection(db, usage("2026-05-28T12:02:00.000Z", { cumulative: false, source: "s", input_tokens: 50, output_tokens: 5 }));
  const u = getSessionUsage(db, sid)!;
  expect(u.input_tokens).toBe(150);
  expect(u.output_tokens).toBe(15);
});

test("cumulative usage replaces totals", () => {
  const db = freshDb();
  applyEventToProjection(db, usage("2026-05-28T12:01:00.000Z", { cumulative: true, source: "s", input_tokens: 100, model: "gpt" }));
  applyEventToProjection(db, usage("2026-05-28T12:02:00.000Z", { cumulative: true, source: "s", input_tokens: 250, model: "gpt" }));
  const u = getSessionUsage(db, sid)!;
  expect(u.input_tokens).toBe(250); // replaced, not summed
  expect(u.last_model).toBe("gpt");
});

test("rate_limit round-trips as decoded JSON", () => {
  const db = freshDb();
  applyEventToProjection(db, usage("2026-05-28T12:01:00.000Z", {
    cumulative: false, source: "s", rate_limit: { remaining: 42 },
  }));
  const u = getSessionUsage(db, sid)!;
  expect(u.last_rate_limit).toEqual({ remaining: 42 });
});
```

- [ ] **Step 8: Run the usage + dedup tests to verify they pass**

Run: `bun test packages/store/tests/usage.test.ts packages/store/tests/dedup.test.ts`
Expected: PASS — including the Task 5 dedup test that was left red (now green: `getSessionUsage` exists and usage applies).

- [ ] **Step 9: Commit**

```bash
git add packages/store/src/project.ts packages/store/src/index.ts packages/store/tests/project.test.ts packages/store/tests/usage.test.ts
git commit -m "store: project adapter events — status state machine, usage aggregate, capabilities"
```

---

## Task 8: Hub — surface usage in the inspect response

**Files:**
- Modify: `packages/hub/src/server.ts`
- Test: `packages/hub/tests/server.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/hub/tests/server.test.ts`, add a test that posts a started + usage event and asserts the inspect response carries `usage`. Match the file's existing setup helpers; if the test file constructs a server with a `Store` and base URL via helpers named differently, mirror those. A self-contained version:

```typescript
import { test, expect } from "bun:test";
import { Store } from "@agmux/store";
import { createServer } from "../src/server.ts";

const sid = "0190a3e0-0000-7000-8000-000000000000";

test("GET /sessions/:id includes usage totals", async () => {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  const base = `http://${server.hostname}:${server.port}`;

  await fetch(`${base}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P", ts: "2026-05-28T12:00:00.000Z",
      session_id: sid, kind: "session.started", version: 1, host: "h",
      payload: { agent_kind: "codex", profile: null, command: "codex", args: [], env_overrides: {}, cwd: "/tmp", pid: 1, tmux_session: null, tmux_window: null, tmux_pane: null, project: null },
    }),
  });
  await fetch(`${base}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q", ts: "2026-05-28T12:01:00.000Z",
      session_id: sid, kind: "usage.reported", version: 1, host: "h",
      payload: { cumulative: false, source: "manual-command", input_tokens: 100 },
    }),
  });

  const r = await fetch(`${base}/sessions/${sid}`);
  const body = await r.json() as any;
  expect(body.usage.input_tokens).toBe(100);
  server.stop();
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/hub/tests/server.test.ts`
Expected: FAIL — `body.usage` is `undefined`.

- [ ] **Step 3: Add `usage` to the inspect response**

In `packages/hub/src/server.ts`, in the `GET /sessions/:id` branch, fetch usage and include it:

```typescript
      const mSession = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (m === "GET" && mSession) {
        const sid = mSession[1]!;
        const session = store.getSession(sid);
        if (!session) return Response.json({ error: "not_found" }, { status: 404 });
        const events = store.listEvents({ session_id: sid, limit: 100 });
        const usage = store.getSessionUsage(sid);
        return Response.json({ session, events, usage });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/hub/tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/server.ts packages/hub/tests/server.test.ts
git commit -m "hub: include session usage in the inspect response"
```

---

## Task 9: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck all packages**

Run: `bun run typecheck`
Expected: no errors across `protocol`, `store`, `hub`, `cli`, `wrapper`.

- [ ] **Step 2: Run the entire test suite**

Run: `bun test`
Expected: PASS. Pay attention to `tests/e2e/*` (they exercise hub ingest + projection); the additive migration must not break them. If an e2e test asserts a `GET /sessions/:id` body shape, the new `usage` field is additive and should not break a field-specific assertion.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Build the hub and post adapter events by hand to see status flip and usage accrue:

```bash
bun run --filter @agmux/hub build
# In one shell: start a hub on a known port via the bootstrap, or reuse an auto-spawned one.
# Then, against the running hub URL ($U), post a started + turn.started + usage and inspect:
U=http://127.0.0.1:<port>
SID=0190a3e0-0000-7000-8000-0000000000aa
curl -s -XPOST $U/ingest -d '{"event_id":"01HZ7P0K8WVQH8WGS8X9DC9001","ts":"2026-05-29T10:00:00.000Z","session_id":"'$SID'","kind":"session.started","version":1,"host":"h","payload":{"agent_kind":"codex","profile":null,"command":"codex","args":[],"env_overrides":{},"cwd":"/tmp","pid":1,"tmux_session":null,"tmux_window":null,"tmux_pane":null,"project":null}}'
curl -s -XPOST $U/ingest -d '{"event_id":"01HZ7P0K8WVQH8WGS8X9DC9002","ts":"2026-05-29T10:00:01.000Z","session_id":"'$SID'","kind":"turn.started","version":1,"host":"h","payload":{}}'
curl -s -XPOST $U/ingest -d '{"event_id":"01HZ7P0K8WVQH8WGS8X9DC9003","ts":"2026-05-29T10:00:02.000Z","session_id":"'$SID'","kind":"usage.reported","version":1,"host":"h","payload":{"cumulative":false,"source":"manual-command","input_tokens":123}}'
curl -s $U/sessions/$SID | grep -o '"status":"[a-z]*"\|"input_tokens":[0-9]*'
```

Expected: `"status":"running"` and `"input_tokens":123`.

- [ ] **Step 4: Commit (if smoke produced any doc/notes changes; otherwise skip)**

No code change expected in this task.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3.1 event kinds → Tasks 2–3, 7. §3.2 usage schema → Task 1 (`UsageReport`) + Task 7 (aggregate). §3.3 envelope/versioning → Task 2 (`dedup_key`, version 1) + Task 3 (lenient). §3.4 + §5.1 guarded state machine → Task 7. §4.4 dedup → Tasks 4–5, 7. §5.2 two-tier usage (raw events kept + `session_usage`) → Tasks 4, 7. §5.3 additive migration → Task 4. §6.2 capabilities at session start (`session.adapter_attached` → `adapter_capabilities`) → Tasks 2, 7. **Deferred to Phase 2 (correctly out of scope):** `agmux emit`, `agmux adapter`, the `@agmux/adapters` package, wrapper `AGMUX_PROFILE` injection, attach resume-plan.
- **Placeholder scan:** none — every code/test step shows full content; commands have expected output.
- **Type consistency:** `getSessionUsage`/`SessionUsageRow` used consistently (Tasks 5, 6, 7, 8); `applyLiveStatus`/`applyUsage`/`ensureUsageRow`/`bumpTurnCount` defined in Task 7 and referenced only there; `EVENT_KINDS_ADAPTER`, payload type names, and `dedup_key` consistent across Tasks 2–7.

> **Known cross-task ordering note:** `packages/store/tests/dedup.test.ts` is written in Task 5 but only goes green at the end of Task 7 (it depends on `getSessionUsage` + usage upsert). This is called out in Task 5 Step 4 and verified in Task 7 Step 8 — intentional, not a gap.
