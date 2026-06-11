# `agmux watch` + `@agmux/tui` + ls ACTIVITY Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ACTIVITY` column to `agmux ls` (current tool / awaited input kind, derived from events server-side) and a live fullscreen `agmux watch` view, built on a new `@agmux/tui` package with a polling `SessionFeed` that can later be swapped for SSE.

**Architecture:** A new `session_activity` projection table in the store (mirrors the `session_usage` pattern) captures `tool.used` and `input.required.kind` — the working/waiting/idle state machine already exists as the session `status` column. The hub needs **zero changes** (the new `SessionRow` fields flow through `Response.json` automatically). A new `@agmux/tui` library package owns row formatting (moved from cli), a `PollingSessionFeed`, and the Ink watch UI; dependency direction is **cli → tui → protocol**, never the reverse.

**Tech Stack:** Bun workspaces, bun:sqlite, bun:test, Ink + React (feasibility-spiked in Task 1; ANSI-repaint fallback defined in Task 7-alt).

**Spec:** `docs/superpowers/specs/2026-06-11-watch-tui-activity-design.md`

**Conventions:** Run all commands from the repo root unless a step says otherwise. Commit messages: short, `<area>: <what>` (e.g. `store: …`, `tui: …`), no AI attribution, no Co-Authored-By lines.

---

### Task 1: Seed `@agmux/tui` + Ink compile spike (DECISION GATE)

Ink renders via yoga-layout (WASM); the `agmux` binary is built with `bun build --compile`. This task proves Ink survives that pipeline **before** we build UI on it.

**Files:**
- Create: `packages/tui/package.json`
- Create: `packages/tui/tsconfig.json`
- Create: `packages/tui/src/index.ts`

- [ ] **Step 1: Scaffold the package**

`packages/tui/package.json`:

```json
{
  "name": "@agmux/tui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@agmux/protocol": "workspace:*"
  }
}
```

`packages/tui/tsconfig.json` (note `jsx` — this package contains `.tsx`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"]
}
```

`packages/tui/src/index.ts` (placeholder, filled by later tasks):

```ts
export {};
```

- [ ] **Step 2: Install deps**

```bash
bun install
cd packages/tui && bun add ink react && bun add -d ink-testing-library @types/react && cd ../..
```

Expected: lockfile updated, `packages/tui/package.json` now lists `ink`, `react`, and dev deps with resolved caret versions.

- [ ] **Step 3: Write the compile spike (NOT committed)**

`/tmp/agmux-ink-spike.tsx`:

```tsx
import React from "react";
import { render, Text } from "ink";

const app = render(<Text>ink-compile-ok</Text>);
app.unmount();
await app.waitUntilExit();
```

- [ ] **Step 4: Run the spike interpreted, then compiled**

```bash
cd packages/tui
bun run /tmp/agmux-ink-spike.tsx
bun build --compile /tmp/agmux-ink-spike.tsx --outfile /tmp/agmux-ink-spike
/tmp/agmux-ink-spike
cd ../..
```

Expected: **both** invocations print `ink-compile-ok` and exit 0.

- [ ] **Step 5: DECISION GATE — record the outcome**

- Both print `ink-compile-ok` → Ink path confirmed. Execute **Task 7** later (skip Task 7-alt).
- Compile or run fails (typically a yoga WASM asset not bundled) → try `bun build --compile --asset-naming="[name].[ext]"` once; if still failing, **Ink is out**: remove `ink`, `react`, `ink-testing-library`, `@types/react` from `packages/tui` (`cd packages/tui && bun remove ink react ink-testing-library @types/react`), drop `"jsx"` from its tsconfig, and execute **Task 7-alt** later (skip Task 7). Tasks 2–6, 8–10 are identical either way.

Note the decision in the commit message body of Step 6.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run --filter @agmux/tui typecheck
git add packages/tui package.json bun.lock
git commit -m "tui: seed package (ink compile spike passed)"
```

(Adjust the message if the gate chose the fallback: `tui: seed package (ink rejected by compile spike, ANSI fallback)`.)

---

### Task 2: `session_activity` table (schema v4 + migration)

**Files:**
- Modify: `packages/store/src/schema.ts`
- Modify: `packages/store/src/migrations.ts`
- Test: `packages/store/tests/migrations.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/store/tests/migrations.test.ts` (match the file's existing imports/style):

```ts
test("v4 creates session_activity and bumps schema_version", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const version = db
    .query<{ value: string }, []>(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    .get();
  expect(version?.value).toBe("4");
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(session_activity)`).all()
    .map((c) => c.name);
  expect(cols).toEqual(["session_id", "last_tool", "last_tool_detail", "last_input_kind", "activity_ts"]);
});
```

If the file lacks `Database`/`runMigrations` imports for this style, add: `import { Database } from "bun:sqlite";` and `import { runMigrations } from "../src/migrations.ts";`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/store/tests/migrations.test.ts`
Expected: FAIL — schema_version is `"3"` / `table_info` returns no rows.

- [ ] **Step 3: Add SCHEMA_V4 and the migration**

Append to `packages/store/src/schema.ts`:

```ts
export const SCHEMA_V4 = `
-- Live-activity projection (what is the agent doing right now). The
-- working/waiting/idle state machine already lives in sessions.status; this
-- table only captures what events would otherwise drop: the current tool
-- (tool.used is log-only without it) and the awaited input kind. No FK,
-- matching session_usage. Null fields = nothing observed (yet).
CREATE TABLE IF NOT EXISTS session_activity (
  session_id       TEXT PRIMARY KEY,
  last_tool        TEXT,
  last_tool_detail TEXT,
  last_input_kind  TEXT,
  activity_ts      TEXT
);
`;
```

In `packages/store/src/migrations.ts`: extend the import to `import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4 } from "./schema.ts";` and append to `MIGRATIONS`:

```ts
  {
    version: 4,
    up: (db) => {
      db.exec(SCHEMA_V4);
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/store/tests/migrations.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/schema.ts packages/store/src/migrations.ts packages/store/tests/migrations.test.ts
git commit -m "store: session_activity table (schema v4)"
```

---

### Task 3: Activity projection rules

**Files:**
- Modify: `packages/store/src/project.ts`
- Modify: `packages/store/src/index.ts` (rebuildProjections)
- Test: `packages/store/tests/activity-projection.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

`packages/store/tests/activity-projection.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

const sid = "0190a3e0-0000-7000-8000-000000000001";
const host = "macbook.local";
let seq = 0;
function ev(kind: string, ts: string, payload: unknown) {
  return {
    event_id: `01HZ7P0K8WVQH8WGS8X9DCA${String(seq++).padStart(3, "0")}`,
    ts, session_id: sid, kind, version: 1, host, payload,
  };
}

function startSession(s: Store): void {
  s.append(ev("session.started", "2026-06-11T12:00:00.000Z", {
    agent_kind: "claude", profile: null, command: "claude",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
    tmux_session: null, tmux_window: null, tmux_pane: null, project: null,
  }));
}

interface ActivityRow {
  last_tool: string | null;
  last_tool_detail: string | null;
  last_input_kind: string | null;
  activity_ts: string | null;
}
function activity(s: Store): ActivityRow | null {
  return s.rawDb()
    .query<ActivityRow, [string]>(
      `SELECT last_tool, last_tool_detail, last_input_kind, activity_ts
         FROM session_activity WHERE session_id = ?`,
    )
    .get(sid) ?? null;
}

test("tool.used upserts tool, detail, and activity_ts", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "src/ls.ts" }));
  expect(activity(s)).toEqual({
    last_tool: "Edit", last_tool_detail: "src/ls.ts",
    last_input_kind: null, activity_ts: "2026-06-11T12:00:02.000Z",
  });
  s.append(ev("tool.used", "2026-06-11T12:00:03.000Z", { tool: "Bash" }));
  expect(activity(s)?.last_tool).toBe("Bash");
  expect(activity(s)?.last_tool_detail).toBeNull();
});

test("input.required sets last_input_kind; input.received clears it", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("input.required", "2026-06-11T12:00:01.000Z", { kind: "permission" }));
  expect(activity(s)?.last_input_kind).toBe("permission");
  s.append(ev("input.received", "2026-06-11T12:00:02.000Z", {}));
  expect(activity(s)?.last_input_kind).toBeNull();
});

test("turn.started clears the previous turn's tool (stale tool must not show as current)", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "a.ts" }));
  s.append(ev("turn.ended", "2026-06-11T12:00:03.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:04.000Z", { tool: "Stale", detail: "x" })); // stray between turns
  s.append(ev("turn.started", "2026-06-11T12:00:05.000Z", {}));
  expect(activity(s)?.last_tool).toBeNull();
  expect(activity(s)?.last_tool_detail).toBeNull();
});

test("turn.ended clears tool and input kind", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "a.ts" }));
  s.append(ev("input.required", "2026-06-11T12:00:03.000Z", { kind: "prompt" }));
  s.append(ev("turn.ended", "2026-06-11T12:00:04.000Z", {}));
  const a = activity(s);
  expect(a?.last_tool).toBeNull();
  expect(a?.last_tool_detail).toBeNull();
  expect(a?.last_input_kind).toBeNull();
});

test("ended guard: activity writes after session.ended are inert", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("session.ended", "2026-06-11T12:00:01.000Z", { exit_code: 0, signal: null, reason: "normal" }));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit" }));
  s.append(ev("input.required", "2026-06-11T12:00:03.000Z", { kind: "prompt" }));
  expect(activity(s)).toBeNull();
});

test("unknown session: activity writes are inert (no orphan rows)", () => {
  const s = Store.openInMemory();
  s.append(ev("tool.used", "2026-06-11T12:00:00.000Z", { tool: "Edit" }));
  expect(activity(s)).toBeNull();
});

test("rebuildProjections clears and replays session_activity", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "a.ts" }));
  s.rebuildProjections();
  expect(activity(s)?.last_tool).toBe("Edit");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/store/tests/activity-projection.test.ts`
Expected: FAIL — `activity(s)` is null everywhere (no projection writes yet).

- [ ] **Step 3: Implement the projection**

In `packages/store/src/project.ts`, replace the relevant `switch` cases in `applyEventToProjection` (the `tool.used / prompt.sent are known but log-only` comment shrinks to `prompt.sent` only):

```ts
    case "turn.started":
      applyLiveStatus(db, ev, "running");
      bumpTurnCount(db, ev);
      clearActivityTool(db, ev);
      return;
    case "turn.ended":
      applyLiveStatus(db, ev, "idle");
      clearActivityAll(db, ev);
      return;
    case "input.required":
      applyLiveStatus(db, ev, "waiting");
      applyActivityInputRequired(db, ev);
      return;
    case "input.received":
      applyLiveStatus(db, ev, "running");
      clearActivityInputKind(db, ev);
      return;
    case "tool.used":
      applyActivityToolUsed(db, ev);
      return;
```

Append the implementations (bottom of file, near the other projection helpers):

```ts
// --- session_activity projection ---------------------------------------------
// Mirrors the applyLiveStatus guard: writes apply only to a session row that
// exists and is not ended, so a stray post-death adapter event is inert and a
// telemetry event for an unknown session can't mint an orphan activity row.
function activityWritable(db: Database, sessionId: string): boolean {
  const row = db.query<{ status: string }, [string]>(
    `SELECT status FROM sessions WHERE session_id = ?`,
  ).get(sessionId);
  return row != null && row.status !== "ended";
}

function applyActivityToolUsed(db: Database, ev: EventEnvelope): void {
  if (!activityWritable(db, ev.session_id)) return;
  const p = ev.payload as any;
  db.query(`
    INSERT INTO session_activity (session_id, last_tool, last_tool_detail, activity_ts)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_tool = excluded.last_tool,
      last_tool_detail = excluded.last_tool_detail,
      activity_ts = excluded.activity_ts
  `).run(ev.session_id, p.tool, p.detail ?? null, ev.ts);
}

function applyActivityInputRequired(db: Database, ev: EventEnvelope): void {
  if (!activityWritable(db, ev.session_id)) return;
  const p = ev.payload as any;
  db.query(`
    INSERT INTO session_activity (session_id, last_input_kind, activity_ts)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_input_kind = excluded.last_input_kind,
      activity_ts = excluded.activity_ts
  `).run(ev.session_id, p.kind ?? null, ev.ts);
}

function clearActivityInputKind(db: Database, ev: EventEnvelope): void {
  if (!activityWritable(db, ev.session_id)) return;
  db.query(`UPDATE session_activity SET last_input_kind = NULL, activity_ts = ? WHERE session_id = ?`)
    .run(ev.ts, ev.session_id);
}

// turn.started: a tool from the previous turn must not show as current.
function clearActivityTool(db: Database, ev: EventEnvelope): void {
  if (!activityWritable(db, ev.session_id)) return;
  db.query(`UPDATE session_activity SET last_tool = NULL, last_tool_detail = NULL, activity_ts = ? WHERE session_id = ?`)
    .run(ev.ts, ev.session_id);
}

function clearActivityAll(db: Database, ev: EventEnvelope): void {
  if (!activityWritable(db, ev.session_id)) return;
  db.query(`UPDATE session_activity SET last_tool = NULL, last_tool_detail = NULL, last_input_kind = NULL, activity_ts = ? WHERE session_id = ?`)
    .run(ev.ts, ev.session_id);
}
```

In `packages/store/src/index.ts` `rebuildProjections()`, add alongside the existing deletes:

```ts
      this.db.exec(`DELETE FROM session_activity`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/store/`
Expected: PASS — new file green, no regressions in the existing store suite.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/project.ts packages/store/src/index.ts packages/store/tests/activity-projection.test.ts
git commit -m "store: activity projection from tool.used/input.required"
```

---

### Task 4: Activity fields on `SessionRow` + query joins

**Files:**
- Modify: `packages/protocol/src/session.ts`
- Modify: `packages/store/src/queries.ts`
- Test: `packages/store/tests/ls-activity.test.ts` (new)

- [ ] **Step 1: Write the failing test**

`packages/store/tests/ls-activity.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

const sid = "0190a3e0-0000-7000-8000-000000000002";
const host = "macbook.local";
let seq = 0;
function ev(kind: string, ts: string, payload: unknown) {
  return {
    event_id: `01HZ7P0K8WVQH8WGS8X9DCB${String(seq++).padStart(3, "0")}`,
    ts, session_id: sid, kind, version: 1, host, payload,
  };
}

function seeded(): Store {
  const s = Store.openInMemory();
  s.append(ev("session.started", "2026-06-11T12:00:00.000Z", {
    agent_kind: "claude", profile: null, command: "claude",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
    tmux_session: null, tmux_window: null, tmux_pane: null, project: null,
  }));
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "src/ls.ts" }));
  return s;
}

test("listSessions joins activity fields", () => {
  const s = seeded();
  const now = new Date("2026-06-11T12:00:03.000Z");
  const row = s.listSessions({ now }).find((r) => r.session_id === sid)!;
  expect(row.last_tool).toBe("Edit");
  expect(row.last_tool_detail).toBe("src/ls.ts");
  expect(row.last_input_kind).toBeNull();
  expect(row.activity_ts).toBe("2026-06-11T12:00:02.000Z");
});

test("listSessions: no activity row decodes to nulls", () => {
  const s = Store.openInMemory();
  s.append(ev("session.started", "2026-06-11T12:00:00.000Z", {
    agent_kind: "claude", profile: null, command: "claude",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
    tmux_session: null, tmux_window: null, tmux_pane: null, project: null,
  }));
  const row = s.listSessions({ now: new Date("2026-06-11T12:00:01.000Z") })[0]!;
  expect(row.last_tool).toBeNull();
  expect(row.last_input_kind).toBeNull();
  expect(row.activity_ts).toBeNull();
});

test("getSession joins activity fields", () => {
  const s = seeded();
  const row = s.getSession(sid, new Date("2026-06-11T12:00:03.000Z"))!;
  expect(row.last_tool).toBe("Edit");
  expect(row.last_tool_detail).toBe("src/ls.ts");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/store/tests/ls-activity.test.ts`
Expected: FAIL — `last_tool` is `undefined` (typecheck may also flag the unknown fields; that is the same failure).

- [ ] **Step 3: Add the fields to `SessionRow`**

In `packages/protocol/src/session.ts`, append inside `interface SessionRow` after `turn_count`:

```ts
  // Joined from the session_activity projection (null/absent = nothing
  // observed). last_tool/_detail are only meaningful while status=running;
  // last_input_kind ("prompt" | "permission" | "confirm") while status=waiting.
  last_tool?: string | null;
  last_tool_detail?: string | null;
  last_input_kind?: string | null;
  activity_ts?: string | null;
```

- [ ] **Step 4: Join in the queries**

In `packages/store/src/queries.ts`:

`decodeRow` — append after `turn_count`:

```ts
    last_tool: raw.last_tool ?? null,
    last_tool_detail: raw.last_tool_detail ?? null,
    last_input_kind: raw.last_input_kind ?? null,
    activity_ts: raw.activity_ts ?? null,
```

`listSessions` — replace the SELECT head of the SQL:

```ts
  const sql = `SELECT s.*, u.turn_count,
                      a.last_tool, a.last_tool_detail, a.last_input_kind, a.activity_ts
               FROM sessions s
               LEFT JOIN session_usage u ON u.session_id = s.session_id
               LEFT JOIN session_activity a ON a.session_id = s.session_id
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY ${sortCol} ${dir}
               ${statuses ? "" : "LIMIT ?"}`;
```

(`sortCol` references `start_ts`/`last_heartbeat_ts`, which are unambiguous — only `sessions` has them — but prefix them with `s.` anyway while touching the query: `s.start_ts`, `COALESCE(s.last_heartbeat_ts, s.start_ts)`. Adjust the `sortCol` assignment accordingly.)

`getSessionRaw` — replace the query:

```ts
  const raw = db.query<any, [string]>(
    `SELECT s.*, a.last_tool, a.last_tool_detail, a.last_input_kind, a.activity_ts
       FROM sessions s
       LEFT JOIN session_activity a ON a.session_id = s.session_id
      WHERE s.session_id = ?`,
  ).get(sid);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/store/ && bun run --filter @agmux/protocol typecheck && bun run --filter @agmux/store typecheck`
Expected: PASS, clean typechecks.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/session.ts packages/store/src/queries.ts packages/store/tests/ls-activity.test.ts
git commit -m "store: join session_activity into session reads"
```

---

### Task 5: Move row formatting to tui; add ACTIVITY column to `ls`

**Files:**
- Create: `packages/tui/src/format.ts`
- Create: `packages/tui/tests/format.test.ts`
- Modify: `packages/tui/src/index.ts`
- Modify: `packages/cli/src/ls.ts`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Write the failing tests**

`packages/tui/tests/format.test.ts`:

```ts
import { test, expect } from "bun:test";
import type { SessionRow, SessionStatus } from "@agmux/protocol";
import { activityCell, formatTable } from "../src/format.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "aaaa", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null,
    activity_ts: null, ...over,
  };
}

test("running with tool renders tool and detail", () => {
  expect(activityCell(mkRow({ last_tool: "Edit", last_tool_detail: "src/ls.ts" })))
    .toBe("tool: Edit src/ls.ts");
});

test("running without tool renders 'working'", () => {
  expect(activityCell(mkRow())).toBe("working");
});

test("waiting renders the input kind, with a generic fallback", () => {
  expect(activityCell(mkRow({ status: "waiting", last_input_kind: "permission" })))
    .toBe("input: permission");
  expect(activityCell(mkRow({ status: "waiting" }))).toBe("input: input");
});

test("idle/ended/lost render '-' even with stale fields", () => {
  for (const status of ["idle", "ended", "lost"] as SessionStatus[]) {
    expect(activityCell(mkRow({ status, last_tool: "Edit" }))).toBe("-");
  }
});

test("cell is capped at 40 chars with ellipsis", () => {
  const cell = activityCell(mkRow({ last_tool: "Bash", last_tool_detail: "x".repeat(60) }));
  expect(cell.length).toBe(40);
  expect(cell.endsWith("…")).toBe(true);
  expect(cell.startsWith("tool: Bash")).toBe(true);
});

test("formatTable includes the ACTIVITY column after TURNS", () => {
  const lines = formatTable([mkRow({ last_tool: "Edit" })], false);
  const header = lines[0]!.split(/\s{2,}/);
  expect(header.indexOf("ACTIVITY")).toBe(header.indexOf("TURNS") + 1);
  expect(lines[1]).toContain("tool: Edit");
});

test("formatTable: reverse flips data rows but keeps the header on top", () => {
  const rows = [
    mkRow({ session_id: "aaaa", start_ts: "2026-06-10T11:00:00.000Z" }),
    mkRow({ session_id: "bbbb", start_ts: "2026-06-10T10:00:00.000Z" }),
  ];
  const flipped = formatTable(rows, true);
  expect(flipped[0]).toStartWith("ID");
  expect(flipped[1]).toStartWith("bbbb");
  expect(flipped[2]).toStartWith("aaaa");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/tui/`
Expected: FAIL — `../src/format.ts` does not exist.

- [ ] **Step 3: Create `packages/tui/src/format.ts`**

Move `formatTable` and `short` verbatim from `packages/cli/src/ls.ts` and add `activityCell` + the column:

```ts
import type { SessionRow } from "@agmux/protocol";

const ACTIVITY_MAX = 40;

// What the agent is doing right now, derived from status + the
// session_activity fields. Only running/waiting have anything to say; stale
// tool fields on idle/closed rows are deliberately not shown.
export function activityCell(r: SessionRow): string {
  if (r.status === "running") {
    if (!r.last_tool) return "working";
    const cell = `tool: ${r.last_tool}${r.last_tool_detail ? ` ${r.last_tool_detail}` : ""}`;
    return cell.length > ACTIVITY_MAX ? cell.slice(0, ACTIVITY_MAX - 1) + "…" : cell;
  }
  if (r.status === "waiting") return `input: ${r.last_input_kind ?? "input"}`;
  return "-";
}

export function formatTable(rows: SessionRow[], reverse: boolean): string[] {
  const header = ["ID", "AGENT", "PROFILE", "STATUS", "TURNS", "ACTIVITY", "PID", "TMUX", "START", "LAST_SEEN"];
  const data = rows.map((r) => [
    r.session_id.slice(0, 23),
    r.agent_kind,
    r.profile ?? "-",
    r.status,
    // "-" = no adapter observation; "0" = adapter watched but no turn happened
    // (nothing to resume); >0 = a real conversation.
    r.turn_count == null ? "-" : String(r.turn_count),
    activityCell(r),
    r.pid?.toString() ?? "-",
    r.tmux_session && r.tmux_window ? `${r.tmux_session}:${r.tmux_window}` : "-",
    short(r.start_ts),
    short(r.last_heartbeat_ts ?? r.start_ts),
  ]);
  // -r flips data rows only — the header stays on top.
  if (reverse) data.reverse();
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length))
  );
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [fmt(header), ...data.map(fmt)];
}

function short(iso: string): string {
  // 2026-05-28T12:00:00.000Z → 05-28 12:00
  return iso.slice(5, 16).replace("T", " ");
}
```

`packages/tui/src/index.ts` becomes:

```ts
export { formatTable, activityCell } from "./format.ts";
```

- [ ] **Step 4: Point cli at the moved code**

`packages/cli/package.json` — add to `dependencies`:

```json
    "@agmux/tui": "workspace:*"
```

then `bun install` to link the workspace.

`packages/cli/src/ls.ts` — delete the local `formatTable` + `short` definitions and import/re-export instead (existing import sites and `packages/cli/tests/ls.test.ts` keep working):

```ts
import type { SessionRow } from "@agmux/protocol";
import { formatTable } from "@agmux/tui";
import type { LsQueryOpts } from "./parse-ls.ts";

export { formatTable };
```

(`buildLsQuery` and `lsCmd` stay unchanged. If the `SessionRow` import becomes unused after the move, drop it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/tui/ packages/cli/ && bun run --filter @agmux/tui typecheck && bun run --filter @agmux/cli typecheck`
Expected: PASS — including the pre-existing `packages/cli/tests/ls.test.ts` against the re-export.

- [ ] **Step 6: Commit**

```bash
git add packages/tui packages/cli/src/ls.ts packages/cli/package.json bun.lock
git commit -m "tui: own row formatting; ls gains ACTIVITY column"
```

---

### Task 6: `SessionFeed` + `PollingSessionFeed`

**Files:**
- Create: `packages/tui/src/feed.ts`
- Create: `packages/tui/tests/feed.test.ts`
- Modify: `packages/tui/src/index.ts`

- [ ] **Step 1: Write the failing tests**

`packages/tui/tests/feed.test.ts` — timers and fetch are injected, so tests drive ticks manually:

```ts
import { test, expect } from "bun:test";
import { PollingSessionFeed } from "../src/feed.ts";

type Tick = () => Promise<void> | void;

function harness(responses: Array<() => Promise<Response>>) {
  let call = 0;
  const urls: string[] = [];
  const fetchImpl = ((url: string) => {
    urls.push(String(url));
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return r();
  }) as unknown as typeof fetch;

  let tick: Tick = () => {};
  let cleared = false;
  const setIntervalImpl = ((fn: Tick) => { tick = fn; return 1 as any; }) as typeof setInterval;
  const clearIntervalImpl = ((_: any) => { cleared = true; }) as typeof clearInterval;

  const feed = new PollingSessionFeed({
    hubUrl: "http://127.0.0.1:9999",
    query: new URLSearchParams({ status: "open" }),
    fetchImpl, setIntervalImpl, clearIntervalImpl,
  });
  return { feed, urls, tickRef: () => tick, wasCleared: () => cleared };
}

const rowsA = [{ session_id: "a" }];
const rowsB = [{ session_id: "b" }];
const ok = (rows: unknown) => () => Promise.resolve(Response.json({ sessions: rows }));

test("first poll fires immediately and delivers rows; query lands in the URL", async () => {
  const h = harness([ok(rowsA)]);
  const updates: unknown[] = [];
  h.feed.subscribe((r) => updates.push(r), () => { throw new Error("unexpected error"); });
  await Bun.sleep(0); // drain the immediate first poll
  expect(updates).toEqual([rowsA]);
  expect(h.urls[0]).toBe("http://127.0.0.1:9999/sessions?status=open");
});

test("unchanged rows are suppressed; changed rows fire onUpdate", async () => {
  const h = harness([ok(rowsA), ok(rowsA), ok(rowsB)]);
  const updates: unknown[] = [];
  h.feed.subscribe((r) => updates.push(r), () => {});
  await Bun.sleep(0);
  await h.tickRef()(); // same rows → suppressed
  await h.tickRef()(); // changed → fires
  expect(updates).toEqual([rowsA, rowsB]);
});

test("non-ok and thrown fetches surface via onError and polling continues", async () => {
  const h = harness([
    () => Promise.resolve(new Response("nope", { status: 500 })),
    () => Promise.reject(new Error("ECONNREFUSED")),
    ok(rowsA),
  ]);
  const updates: unknown[] = [];
  const errors: string[] = [];
  h.feed.subscribe((r) => updates.push(r), (e) => errors.push(e.message));
  await Bun.sleep(0);
  await h.tickRef()();
  await h.tickRef()();
  expect(errors).toEqual(["hub error 500", "ECONNREFUSED"]);
  expect(updates).toEqual([rowsA]);
});

test("in-flight guard: a tick during a pending fetch is skipped", async () => {
  let release!: (r: Response) => void;
  const gated = new Promise<Response>((res) => { release = res; });
  const h = harness([() => gated, ok(rowsB)]);
  const updates: unknown[] = [];
  h.feed.subscribe((r) => updates.push(r), () => {});
  await h.tickRef()(); // skipped: first (immediate) poll still pending
  release(Response.json({ sessions: rowsA }));
  await Bun.sleep(0);
  expect(updates).toEqual([rowsA]); // the gated overlap tick fetched nothing
});

test("unsubscribe clears the interval and silences late results", async () => {
  let release!: (r: Response) => void;
  const gated = new Promise<Response>((res) => { release = res; });
  const h = harness([() => gated]);
  const updates: unknown[] = [];
  const stop = h.feed.subscribe((r) => updates.push(r), () => {});
  stop();
  expect(h.wasCleared()).toBe(true);
  release(Response.json({ sessions: rowsA }));
  await Bun.sleep(0);
  expect(updates).toEqual([]); // in-flight result after stop is dropped
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/tui/tests/feed.test.ts`
Expected: FAIL — `../src/feed.ts` does not exist.

- [ ] **Step 3: Implement `packages/tui/src/feed.ts`**

```ts
import type { SessionRow } from "@agmux/protocol";

// The seam between UIs and the hub. Today: polling. When the comms milestone
// adds real streaming to the hub, an SSE-backed implementation replaces this
// without any UI change (polling stays as the reconnect fallback).
export interface SessionFeed {
  /** Starts delivery; returns an unsubscribe function. onUpdate fires only when rows changed. */
  subscribe(onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void): () => void;
}

export interface PollingFeedOpts {
  hubUrl: string;
  query: URLSearchParams;     // built by the caller (cli: buildLsQuery)
  intervalMs?: number;        // default 1000
  // Injection points for tests.
  fetchImpl?: typeof fetch;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export class PollingSessionFeed implements SessionFeed {
  constructor(private readonly o: PollingFeedOpts) {}

  subscribe(onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void): () => void {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const url = `${this.o.hubUrl}/sessions?${this.o.query.toString()}`;
    let inFlight = false;
    let stopped = false;
    let lastKey = "";

    const tick = async (): Promise<void> => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const r = await fetchImpl(url);
        if (!r.ok) throw new Error(`hub error ${r.status}`);
        const { sessions } = (await r.json()) as { sessions: SessionRow[] };
        const key = JSON.stringify(sessions);
        if (!stopped && key !== lastKey) {
          lastKey = key;
          onUpdate(sessions);
        }
      } catch (e) {
        if (!stopped) onError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        inFlight = false;
      }
    };

    const timer = (this.o.setIntervalImpl ?? setInterval)(tick, this.o.intervalMs ?? 1000);
    void tick(); // immediate first poll — don't make the user wait one interval
    return () => {
      stopped = true;
      (this.o.clearIntervalImpl ?? clearInterval)(timer);
    };
  }
}
```

`packages/tui/src/index.ts` becomes:

```ts
export { formatTable, activityCell } from "./format.ts";
export { PollingSessionFeed, type SessionFeed, type PollingFeedOpts } from "./feed.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/tui/ && bun run --filter @agmux/tui typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/feed.ts packages/tui/src/index.ts packages/tui/tests/feed.test.ts
git commit -m "tui: SessionFeed + polling implementation"
```

---

### Task 7: Ink watch UI (`SessionTable`, `WatchApp`, `runWatch`)

**Execute this task only if the Task 1 gate confirmed Ink. Otherwise execute Task 7-alt.**

**Files:**
- Create: `packages/tui/src/session-table.tsx`
- Create: `packages/tui/src/watch-app.tsx`
- Create: `packages/tui/src/run-watch.tsx`
- Create: `packages/tui/tests/watch-app.test.tsx`
- Modify: `packages/tui/src/index.ts`

- [ ] **Step 1: Write the failing tests**

`packages/tui/tests/watch-app.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "../src/feed.ts";
import { WatchApp } from "../src/watch-app.tsx";

function mkRow(sid: string): SessionRow {
  return {
    session_id: sid, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: 1, last_tool: "Edit", last_tool_detail: "a.ts", last_input_kind: null,
    activity_ts: null,
  };
}

// A feed the test drives by hand.
function manualFeed() {
  let update: (rows: SessionRow[]) => void = () => {};
  let error: (e: Error) => void = () => {};
  let unsubscribed = false;
  const feed: SessionFeed = {
    subscribe(onUpdate, onError) {
      update = onUpdate; error = onError;
      return () => { unsubscribed = true; };
    },
  };
  return { feed, push: (r: SessionRow[]) => update(r), fail: (e: Error) => error(e),
           wasUnsubscribed: () => unsubscribed };
}

test("renders connecting state, then the table on first update", () => {
  const m = manualFeed();
  const { lastFrame } = render(
    <WatchApp feed={m.feed} reverse={false} hubUrl="http://h" clock={() => "12:00:00"} />,
  );
  expect(lastFrame()).toContain("connecting to http://h");
  m.push([mkRow("aaaa")]);
  expect(lastFrame()).toContain("tool: Edit a.ts");
  expect(lastFrame()).toContain("1 sessions · refreshed 12:00:00 · q to quit");
});

test("feed error keeps the last table and shows reconnecting in the footer", () => {
  const m = manualFeed();
  const { lastFrame } = render(
    <WatchApp feed={m.feed} reverse={false} hubUrl="http://h" clock={() => "12:00:00"} />,
  );
  m.push([mkRow("aaaa")]);
  m.fail(new Error("ECONNREFUSED"));
  expect(lastFrame()).toContain("aaaa");             // table retained
  expect(lastFrame()).toContain("reconnecting");
  m.push([mkRow("bbbb")]);                            // recovery clears the error
  expect(lastFrame()).not.toContain("reconnecting");
});

test("q exits and unsubscribes the feed", async () => {
  const m = manualFeed();
  const { stdin, unmount } = render(
    <WatchApp feed={m.feed} reverse={false} hubUrl="http://h" clock={() => "12:00:00"} />,
  );
  m.push([mkRow("aaaa")]);
  stdin.write("q");
  await Bun.sleep(0); // let ink process exit + effect cleanup
  expect(m.wasUnsubscribed()).toBe(true);
  unmount();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/tui/tests/watch-app.test.tsx`
Expected: FAIL — `../src/watch-app.tsx` does not exist.

- [ ] **Step 3: Implement the components**

`packages/tui/src/session-table.tsx` — the Ink face of the exact `ls` formatting:

```tsx
import React from "react";
import { Text } from "ink";
import type { SessionRow } from "@agmux/protocol";
import { formatTable } from "./format.ts";

export function SessionTable({ rows, reverse }: { rows: SessionRow[]; reverse: boolean }) {
  return <Text>{formatTable(rows, reverse).join("\n")}</Text>;
}
```

`packages/tui/src/watch-app.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "./feed.ts";
import { SessionTable } from "./session-table.tsx";

export interface WatchAppProps {
  feed: SessionFeed;
  reverse: boolean;
  hubUrl: string;
  clock?: () => string; // injected in tests; defaults to wall-clock HH:MM:SS
}

export function WatchApp({ feed, reverse, hubUrl, clock }: WatchAppProps) {
  const { exit } = useApp();
  const now = clock ?? (() => new Date().toTimeString().slice(0, 8));
  const [rows, setRows] = useState<SessionRow[] | null>(null); // null = nothing received yet
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState("");

  useInput((input) => { if (input === "q") exit(); });

  // subscribe() returns its own unsubscribe — exactly the effect cleanup shape.
  useEffect(() => feed.subscribe(
    (r) => { setRows(r); setError(null); setRefreshedAt(now()); },
    (e) => setError(e.message),
  ), [feed]);

  return (
    <Box flexDirection="column">
      {rows === null
        ? <Text dimColor>connecting to {hubUrl}…</Text>
        : <SessionTable rows={rows} reverse={reverse} />}
      <Text dimColor>
        {error
          ? `hub unreachable — reconnecting… (${error})`
          : `${rows?.length ?? 0} sessions · refreshed ${refreshedAt} · q to quit`}
      </Text>
    </Box>
  );
}
```

`packages/tui/src/run-watch.tsx` — the cli-facing entry; owns the alternate screen buffer (Ink does not):

```tsx
import React from "react";
import { render } from "ink";
import { PollingSessionFeed } from "./feed.ts";
import { WatchApp } from "./watch-app.tsx";

export interface RunWatchOpts {
  hubUrl: string;
  query: URLSearchParams;
  intervalMs: number;
  reverse: boolean;
}

export async function runWatch(o: RunWatchOpts): Promise<number> {
  const feed = new PollingSessionFeed({ hubUrl: o.hubUrl, query: o.query, intervalMs: o.intervalMs });
  process.stdout.write("\x1b[?1049h\x1b[H"); // enter alt screen, home cursor
  try {
    const app = render(<WatchApp feed={feed} reverse={o.reverse} hubUrl={o.hubUrl} />, { exitOnCtrlC: true });
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l"); // restore the user's screen even on throw
  }
  return 0;
}
```

`packages/tui/src/index.ts` becomes:

```ts
export { formatTable, activityCell } from "./format.ts";
export { PollingSessionFeed, type SessionFeed, type PollingFeedOpts } from "./feed.ts";
export { runWatch, type RunWatchOpts } from "./run-watch.tsx";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/tui/ && bun run --filter @agmux/tui typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src packages/tui/tests/watch-app.test.tsx
git commit -m "tui: ink watch UI (SessionTable, WatchApp, runWatch)"
```

---

### Task 7-alt: ANSI-repaint watch UI (only if the Task 1 gate rejected Ink)

Same `runWatch` signature as Task 7 so Tasks 8–9 are unchanged. No React: a repaint loop over `formatTable` output plus raw-mode `q` handling.

**Files:**
- Create: `packages/tui/src/run-watch.ts`
- Create: `packages/tui/tests/run-watch.test.ts`
- Modify: `packages/tui/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/tui/tests/run-watch.test.ts` — tests the pure frame renderer (the loop wiring is exercised by the manual check in Task 10):

```ts
import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { renderWatchFrame } from "../src/run-watch.ts";

function mkRow(sid: string): SessionRow {
  return {
    session_id: sid, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: 1, last_tool: "Edit", last_tool_detail: "a.ts", last_input_kind: null,
    activity_ts: null,
  };
}

test("frame contains table, footer, and clears the screen", () => {
  const frame = renderWatchFrame({ rows: [mkRow("aaaa")], reverse: false, error: null, refreshedAt: "12:00:00", hubUrl: "http://h" });
  expect(frame).toStartWith("\x1b[2J\x1b[H");
  expect(frame).toContain("tool: Edit a.ts");
  expect(frame).toContain("1 sessions · refreshed 12:00:00 · q to quit");
});

test("error frame keeps the table and shows reconnecting", () => {
  const frame = renderWatchFrame({ rows: [mkRow("aaaa")], reverse: false, error: "ECONNREFUSED", refreshedAt: "12:00:00", hubUrl: "http://h" });
  expect(frame).toContain("aaaa");
  expect(frame).toContain("hub unreachable — reconnecting… (ECONNREFUSED)");
});

test("null rows render the connecting state", () => {
  const frame = renderWatchFrame({ rows: null, reverse: false, error: null, refreshedAt: "", hubUrl: "http://h" });
  expect(frame).toContain("connecting to http://h");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/run-watch.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `packages/tui/src/run-watch.ts`**

```ts
import type { SessionRow } from "@agmux/protocol";
import { PollingSessionFeed } from "./feed.ts";
import { formatTable } from "./format.ts";

export interface RunWatchOpts {
  hubUrl: string;
  query: URLSearchParams;
  intervalMs: number;
  reverse: boolean;
}

export interface WatchFrameState {
  rows: SessionRow[] | null; // null = nothing received yet
  reverse: boolean;
  error: string | null;
  refreshedAt: string;
  hubUrl: string;
}

// Pure frame renderer — unit-testable without a TTY.
export function renderWatchFrame(s: WatchFrameState): string {
  const body = s.rows === null
    ? `connecting to ${s.hubUrl}…`
    : formatTable(s.rows, s.reverse).join("\n");
  const footer = s.error
    ? `hub unreachable — reconnecting… (${s.error})`
    : `${s.rows?.length ?? 0} sessions · refreshed ${s.refreshedAt} · q to quit`;
  return `\x1b[2J\x1b[H${body}\n${footer}\n`;
}

export async function runWatch(o: RunWatchOpts): Promise<number> {
  const feed = new PollingSessionFeed({ hubUrl: o.hubUrl, query: o.query, intervalMs: o.intervalMs });
  const state: WatchFrameState = { rows: null, reverse: o.reverse, error: null, refreshedAt: "", hubUrl: o.hubUrl };
  const repaint = () => process.stdout.write(renderWatchFrame(state));

  process.stdout.write("\x1b[?1049h"); // alt screen
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise<number>((resolve) => {
    const stopFeed = feed.subscribe(
      (rows) => {
        state.rows = rows; state.error = null;
        state.refreshedAt = new Date().toTimeString().slice(0, 8);
        repaint();
      },
      (e) => { state.error = e.message; repaint(); },
    );
    const finish = () => {
      stopFeed();
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?1049l"); // restore the user's screen
      resolve(0);
    };
    process.stdin.on("data", (b: Buffer) => {
      const ch = b.toString("utf8");
      if (ch === "q" || ch === "\x03" /* Ctrl-C in raw mode */) finish();
    });
    repaint();
  });
}
```

`packages/tui/src/index.ts` becomes:

```ts
export { formatTable, activityCell } from "./format.ts";
export { PollingSessionFeed, type SessionFeed, type PollingFeedOpts } from "./feed.ts";
export { runWatch, type RunWatchOpts, renderWatchFrame } from "./run-watch.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/tui/ && bun run --filter @agmux/tui typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src packages/tui/tests/run-watch.test.ts
git commit -m "tui: ANSI-repaint watch UI"
```

---

### Task 8: `watch` argument parsing (cli)

**Files:**
- Create: `packages/cli/src/parse-watch.ts`
- Create: `packages/cli/tests/parse-watch.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/cli/tests/parse-watch.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseWatchArgs } from "../src/parse-watch.ts";

test("defaults: status open, sort started desc, 1s interval", () => {
  const p = parseWatchArgs([]);
  if (p.kind !== "ok") throw new Error(p.message);
  expect(p.opts.status).toBe("open");
  expect(p.opts.sort).toBe("started");
  expect(p.opts.asc).toBe(false);
  expect(p.opts.intervalMs).toBe(1000);
});

test("ls flags pass through and override watch defaults", () => {
  const p = parseWatchArgs(["--status", "active", "--sort", "activity", "-n", "10", "-r"]);
  if (p.kind !== "ok") throw new Error(p.message);
  expect(p.opts.status).toBe("active");
  expect(p.opts.sort).toBe("activity");
  expect(p.opts.limit).toBe(10);
  expect(p.opts.reverse).toBe(true);
});

test("--interval accepts seconds in both flag forms, including fractions", () => {
  const a = parseWatchArgs(["--interval", "5"]);
  if (a.kind !== "ok") throw new Error(a.message);
  expect(a.opts.intervalMs).toBe(5000);
  const b = parseWatchArgs(["-i=0.5"]);
  if (b.kind !== "ok") throw new Error(b.message);
  expect(b.opts.intervalMs).toBe(500);
});

test("invalid interval errors", () => {
  expect(parseWatchArgs(["--interval", "0"]).kind).toBe("error");
  expect(parseWatchArgs(["--interval", "abc"]).kind).toBe("error");
  expect(parseWatchArgs(["--interval"]).kind).toBe("error");
});

test("unknown flag errors with a watch-prefixed message", () => {
  const p = parseWatchArgs(["--bogus"]);
  expect(p.kind).toBe("error");
  if (p.kind === "error") expect(p.message).toStartWith("watch:");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/tests/parse-watch.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `packages/cli/src/parse-watch.ts`**

```ts
import type { LsConfig } from "@agmux/wrapper";
import { parseLsArgs, type LsQueryOpts } from "./parse-ls.ts";

export interface WatchOpts extends LsQueryOpts {
  intervalMs: number;
}

export type ParsedWatch =
  | { kind: "ok"; opts: WatchOpts }
  | { kind: "error"; message: string };

// watch deliberately ignores [ls] config defaults. Built-ins: status=open
// (closed sessions don't change), sort=started (stable ordering — rows must
// not jump around mid-watch while sessions have no human-readable label).
const WATCH_DEFAULTS: LsConfig = { status: "open", sort: "started" };

export function parseWatchArgs(argv: string[]): ParsedWatch {
  const rest: string[] = [];
  let intervalSec: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (name === "-i" || name === "--interval") {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      const num = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(num) || num <= 0)
        return { kind: "error", message: `watch: ${name} requires a positive number of seconds` };
      intervalSec = num;
    } else {
      rest.push(a);
    }
  }

  const parsed = parseLsArgs(rest, WATCH_DEFAULTS);
  if (parsed.kind === "error")
    return { kind: "error", message: parsed.message.replace(/^ls:/, "watch:") };
  return { kind: "ok", opts: { ...parsed.opts, intervalMs: Math.round((intervalSec ?? 1) * 1000) } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/tests/parse-watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parse-watch.ts packages/cli/tests/parse-watch.test.ts
git commit -m "cli: watch arg parsing"
```

---

### Task 9: Wire `agmux watch` (cli)

**Files:**
- Create: `packages/cli/src/watch.ts`
- Create: `packages/cli/tests/watch.test.ts`
- Modify: `packages/cli/bin/agmux.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/tests/watch.test.ts` — the TTY gate is the only logic here beyond delegation, so test that path with injected deps:

```ts
import { test, expect } from "bun:test";
import { watchCmd } from "../src/watch.ts";

const opts = {
  limit: 50, sort: "started" as const, asc: false, reverse: false,
  status: "open", intervalMs: 1000, hubUrl: "http://127.0.0.1:9999",
};

test("non-TTY exits 2 without invoking the UI", async () => {
  const errs: string[] = [];
  let ran = false;
  const code = await watchCmd(opts, {
    isTTY: () => false,
    runWatchImpl: async () => { ran = true; return 0; },
    errOut: (s) => errs.push(s),
  });
  expect(code).toBe(2);
  expect(ran).toBe(false);
  expect(errs[0]).toContain("requires a TTY");
});

test("TTY delegates to runWatch with the built query", async () => {
  let got: { query: URLSearchParams; intervalMs: number } | null = null;
  const code = await watchCmd(opts, {
    isTTY: () => true,
    runWatchImpl: async (o) => { got = { query: o.query, intervalMs: o.intervalMs }; return 0; },
    errOut: () => {},
  });
  expect(code).toBe(0);
  expect(got!.query.get("status")).toBe("open");
  expect(got!.query.get("sort")).toBe("started");
  expect(got!.intervalMs).toBe(1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/watch.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `packages/cli/src/watch.ts`**

```ts
import { runWatch, type RunWatchOpts } from "@agmux/tui";
import { buildLsQuery } from "./ls.ts";
import type { WatchOpts } from "./parse-watch.ts";

export interface WatchCmdDeps {
  isTTY: () => boolean;
  runWatchImpl: (o: RunWatchOpts) => Promise<number>;
  errOut: (s: string) => void;
}

const defaultDeps: WatchCmdDeps = {
  isTTY: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  runWatchImpl: runWatch,
  errOut: (s) => console.error(s),
};

export async function watchCmd(
  opts: WatchOpts & { hubUrl: string },
  deps: WatchCmdDeps = defaultDeps,
): Promise<number> {
  if (!deps.isTTY()) {
    deps.errOut("watch: requires a TTY (use `agmux ls` for scripted output)");
    return 2;
  }
  return deps.runWatchImpl({
    hubUrl: opts.hubUrl,
    query: buildLsQuery(opts),
    intervalMs: opts.intervalMs,
    reverse: opts.reverse,
  });
}
```

- [ ] **Step 4: Wire the verb**

`packages/cli/src/index.ts` — add:

```ts
export * from "./watch.ts";
```

`packages/cli/bin/agmux.ts`:

Add imports:

```ts
import { watchCmd } from "../src/watch.ts";
import { parseWatchArgs } from "../src/parse-watch.ts";
```

Add a `case` in the `switch` after `case "ls"`:

```ts
    case "watch": {
      const parsed = parseWatchArgs(argv.slice(1));
      if (parsed.kind === "error") { console.error(parsed.message); return 2; }
      return watchCmd({ ...parsed.opts, hubUrl });
    }
```

Add to `usage()` after the `ls` lines:

```
  watch [ls flags] [-i/--interval <seconds>]
     fullscreen live view of ls (defaults: --status open --sort started); q quits
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/cli/ && bun run --filter @agmux/cli typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/watch.ts packages/cli/src/index.ts packages/cli/bin/agmux.ts packages/cli/tests/watch.test.ts
git commit -m "cli: agmux watch verb"
```

---

### Task 10: Full verification, build, docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full suite, typecheck, build**

```bash
bun test
bun run typecheck
bun run build
```

Expected: all green; `packages/cli/dist/agmux` rebuilt **with the tui/Ink code compiled in** (this is the real-world re-check of the Task 1 spike — if `bun build --compile` fails here, revisit the Task 1 gate decision).

- [ ] **Step 2: Manual smoke test (compiled binary, real hub)**

```bash
packages/cli/dist/agmux ls          # ACTIVITY column present; closed rows show "-"
packages/cli/dist/agmux watch       # fullscreen, footer line, q exits, screen restored
packages/cli/dist/agmux watch -i 2 --status closed   # flags respected
echo | packages/cli/dist/agmux watch                 # non-TTY → exit 2 with hint
```

Expected: as annotated. If a live agent session is available, confirm `tool:` / `input:` cells change during a turn (best-effort — depends on an adapter emitting `tool.used`).

- [ ] **Step 3: Update README**

In `README.md`, in the Quickstart command block after the `agmux ls --all` line, add:

```bash
agmux watch                  # fullscreen live view of ls (status open, sorted by start); q quits
agmux watch -i 2 --agent claude   # accepts ls filter flags + -i/--interval seconds
```

And in the same block's `ls` section (or directly after the `ls` lines), add a one-liner noting the new column:

```
# ls/watch show an ACTIVITY column: current tool while running, awaited input kind while waiting
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: agmux watch + ACTIVITY column"
```
