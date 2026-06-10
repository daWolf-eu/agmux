# `agmux ls` Sort/Limit/Status-Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `-n/--limit`, `--sort`, `--asc`, `-r/--reverse`, and `--status` to `agmux ls`, with personal defaults in a `[ls]` section of `~/.config/agmux/config.toml`.

**Architecture:** Sorting and status filtering happen hub-side: the `/sessions` endpoint gains `sort`/`order`/`status` query params, mapped through whitelists in `listSessions` (store). Because `lost` status is computed in JS, the status filter runs after status computation and the row limit is applied after the filter. The CLI resolves flag > config > built-in-default precedence in a new `parse-ls.ts`, and `-r` flips display rows client-side.

**Tech Stack:** TypeScript on Bun (monorepo workspaces), bun:sqlite, smol-toml, bun:test.

**Spec:** `docs/superpowers/specs/2026-06-10-ls-sort-filter-design.md`

**Conventions:** Commit messages are short, no AI/co-author attribution. Run commands from the repo root.

---

### Task 1: Protocol — status group expansion

**Files:**
- Modify: `packages/protocol/src/session.ts`
- Test: `packages/protocol/tests/status-filter.test.ts` (create)

The status vocabulary lives in `packages/protocol/src/session.ts` (`SESSION_STATUSES`, `LIVE_STATUSES`). Group aliases are shared vocabulary between the CLI (flag validation), the wrapper (config validation), and the hub (query parsing), so they belong here too.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/tests/status-filter.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { expandStatusFilter } from "../src/session.ts";

test("expands group aliases", () => {
  expect(expandStatusFilter("active")).toEqual(["running", "waiting"]);
  expect(expandStatusFilter("open")).toEqual(["running", "waiting", "idle"]);
  expect(expandStatusFilter("closed")).toEqual(["ended", "lost"]);
});

test("accepts comma-separated raw statuses", () => {
  expect(expandStatusFilter("running,lost")).toEqual(["running", "lost"]);
  expect(expandStatusFilter("idle")).toEqual(["idle"]);
});

test("rejects unknown values", () => {
  expect(expandStatusFilter("foo")).toBeNull();
  expect(expandStatusFilter("running,foo")).toBeNull();
  expect(expandStatusFilter("")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/tests/status-filter.test.ts`
Expected: FAIL — `expandStatusFilter` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/protocol/src/session.ts`:

```typescript
// `agmux ls --status` vocabulary: group aliases over the raw statuses.
export const STATUS_GROUPS: Record<string, readonly SessionStatus[]> = {
  active: ["running", "waiting"],
  open: ["running", "waiting", "idle"],
  closed: ["ended", "lost"],
};

// "active" | "open" | "closed" | comma-separated raw statuses → status list.
// Returns null for anything else (caller decides how to error).
export function expandStatusFilter(value: string): SessionStatus[] | null {
  const group = STATUS_GROUPS[value];
  if (group) return [...group];
  const parts = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const out: SessionStatus[] = [];
  for (const p of parts) {
    if (!(SESSION_STATUSES as readonly string[]).includes(p)) return null;
    out.push(p as SessionStatus);
  }
  return out;
}
```

(`packages/protocol/src/index.ts` already does `export * from "./session.ts"` — no change needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/tests/status-filter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/session.ts packages/protocol/tests/status-filter.test.ts
git commit -m "protocol: status filter groups for ls"
```

---

### Task 2: Store — sort column/direction + status filter with post-filter limit

**Files:**
- Modify: `packages/store/src/queries.ts:42-71` (`ListSessionsOpts`, `listSessions`)
- Test: `packages/store/tests/list-sort.test.ts` (create)

`lost` is computed in `computeEffectiveStatus` (heartbeat staleness), so a status filter can only run after that computation — and the row limit must then be applied after the filter, otherwise `--status running -n 5` returns fewer than 5 rows when newer non-matching rows exist (the current `live` bug). Test rows use `origin: 'native'` because `computeEffectiveStatus` returns native rows' stored status as-is (`packages/store/src/lost.ts:17`), keeping fixtures deterministic.

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/list-sort.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { listSessions } from "../src/queries.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

// origin='native' → computeEffectiveStatus reports the stored status as-is,
// so fixtures stay deterministic regardless of `now`.
function ins(db: Database, sid: string, o: { status?: string; start?: string; hb?: string | null } = {}) {
  db.query(`INSERT INTO sessions (session_id, agent_kind, profile, native_session_id, command,
              args_json, env_json, cwd, pid, host, start_ts, last_heartbeat_ts, status, origin)
            VALUES (?, 'claude', NULL, ?, 'claude', '[]', '{}', '/tmp', 1, 'h', ?, ?, ?, 'native')`)
    .run(sid, "nat-" + sid, o.start ?? "2026-06-10T10:00:00.000Z", o.hb ?? null, o.status ?? "running");
}

test("sort=activity orders by COALESCE(last_heartbeat_ts, start_ts)", () => {
  const db = makeDb();
  ins(db, "a", { start: "2026-06-10T10:00:00.000Z", hb: "2026-06-10T10:05:00.000Z" });
  ins(db, "b", { start: "2026-06-10T10:01:00.000Z", hb: null }); // activity = start
  ins(db, "c", { start: "2026-06-10T09:00:00.000Z", hb: "2026-06-10T10:10:00.000Z" });
  expect(listSessions(db, { sort: "activity" }).map((r) => r.session_id)).toEqual(["c", "a", "b"]);
  expect(listSessions(db, { sort: "started" }).map((r) => r.session_id)).toEqual(["b", "a", "c"]);
});

test("order=asc flips the direction", () => {
  const db = makeDb();
  ins(db, "a", { start: "2026-06-10T10:00:00.000Z" });
  ins(db, "b", { start: "2026-06-10T11:00:00.000Z" });
  expect(listSessions(db, { sort: "started", order: "asc" }).map((r) => r.session_id)).toEqual(["a", "b"]);
});

test("statuses filters to the given set", () => {
  const db = makeDb();
  ins(db, "a", { status: "running" });
  ins(db, "b", { status: "ended" });
  ins(db, "c", { status: "lost" });
  ins(db, "d", { status: "idle" });
  const rows = listSessions(db, { statuses: ["ended", "lost"] });
  expect(rows.map((r) => r.session_id).sort()).toEqual(["b", "c"]);
});

test("limit applies after the status filter, not before", () => {
  const db = makeDb();
  // 5 ended sessions, all newer than the running ones: a naive SQL LIMIT
  // would fetch only ended rows and starve the filter.
  for (let i = 0; i < 5; i++) ins(db, `e${i}`, { status: "ended", start: `2026-06-10T12:0${i}:00.000Z` });
  for (let i = 0; i < 3; i++) ins(db, `r${i}`, { status: "running", start: `2026-06-10T08:0${i}:00.000Z` });
  const rows = listSessions(db, { statuses: ["running"], limit: 2 });
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.status === "running")).toBe(true);
});

test("live limit applies after the live filter (regression)", () => {
  const db = makeDb();
  for (let i = 0; i < 3; i++) ins(db, `e${i}`, { status: "ended", start: `2026-06-10T12:0${i}:00.000Z` });
  ins(db, "r0", { status: "running", start: "2026-06-10T08:00:00.000Z" });
  const rows = listSessions(db, { live: true, limit: 2 });
  expect(rows.map((r) => r.session_id)).toEqual(["r0"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/store/tests/list-sort.test.ts`
Expected: FAIL — `sort`/`order`/`statuses` not in `ListSessionsOpts` (type error) / wrong ordering and starvation at runtime.

- [ ] **Step 3: Implement**

In `packages/store/src/queries.ts`, replace `ListSessionsOpts` and `listSessions` (currently lines 42–71) with:

```typescript
export interface ListSessionsOpts {
  live?: boolean;                       // alias for statuses=LIVE_STATUSES
  statuses?: readonly SessionStatus[];  // post-computation filter; wins over `live`
  agent_kind?: string;
  profile?: string;
  since?: string;
  limit?: number;
  sort?: "started" | "activity";
  order?: "asc" | "desc";
  now?: Date;
}

export function listSessions(db: Database, opts: ListSessionsOpts): SessionRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.agent_kind) { where.push("agent_kind = ?"); params.push(opts.agent_kind); }
  if (opts.profile)    { where.push("profile = ?");    params.push(opts.profile); }
  if (opts.since)      { where.push("start_ts >= ?");  params.push(opts.since); }

  // Whitelist-mapped ORDER BY — caller input never reaches the SQL string.
  const sortCol = opts.sort === "activity" ? "COALESCE(last_heartbeat_ts, start_ts)" : "start_ts";
  const dir = opts.order === "asc" ? "ASC" : "DESC";

  // Status is computed in JS (lost = heartbeat staleness), so with a status
  // filter the row cap must apply AFTER filtering — a SQL LIMIT would starve
  // the result when newer rows fail the filter.
  const statuses = opts.statuses ?? (opts.live ? LIVE_STATUSES : undefined);
  const limit = opts.limit ?? 200;

  const sql = `SELECT s.*, u.turn_count FROM sessions s
               LEFT JOIN session_usage u ON u.session_id = s.session_id
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY ${sortCol} ${dir}
               ${statuses ? "" : "LIMIT ?"}`;
  if (!statuses) params.push(limit);
  const raws = db.query<any, any[]>(sql).all(...(params as any[]));
  const now = opts.now ?? new Date();
  let rows = raws.map(decodeRow).map((r) => {
    r.status = computeEffectiveStatus(r, now);
    return r;
  });
  if (statuses) rows = rows.filter((r) => statuses.includes(r.status)).slice(0, limit);
  return rows;
}
```

(`LIVE_STATUSES` is already imported at the top of the file.)

- [ ] **Step 4: Run tests to verify they pass — including existing ones**

Run: `bun test packages/store`
Expected: PASS, all store tests (the existing `queries.test.ts` live-filter tests must stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/queries.ts packages/store/tests/list-sort.test.ts
git commit -m "store: sort/order + status filter in listSessions"
```

---

### Task 3: Hub — `/sessions` gains `sort`, `order`, `status` params

**Files:**
- Modify: `packages/hub/src/server.ts:43-59` (the `GET /sessions` block) and its imports
- Test: `packages/hub/tests/server.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/tests/server.test.ts`:

```typescript
test("GET /sessions?status=closed returns only ended/lost", async () => {
  const { server, url } = makeServer();
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv) });
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F40",
      ts: new Date(Date.now() + 1000).toISOString(),
      session_id: startedEv.session_id,
      kind: "session.ended", version: 1, host: "macbook.local",
      payload: { exit_code: 0, signal: null, reason: "normal" } }) });
  const closed = await (await fetch(`${url}/sessions?status=closed`)).json() as any;
  expect(closed.sessions).toHaveLength(1);
  expect(closed.sessions[0].status).toBe("ended");
  const active = await (await fetch(`${url}/sessions?status=active`)).json() as any;
  expect(active.sessions).toHaveLength(0);
  server.stop();
});

test("GET /sessions?sort=started&order=asc orders oldest first", async () => {
  const { server, url } = makeServer();
  const older = { ...startedEv, event_id: "01HZ7P0K8WVQH8WGS8X9DC9F41",
    session_id: "0190a3e0-0000-7000-8000-00000000000a",
    ts: new Date(Date.now() - 60_000).toISOString() };
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([older, startedEv]) });
  const asc = await (await fetch(`${url}/sessions?sort=started&order=asc`)).json() as any;
  expect(asc.sessions.map((s: any) => s.session_id)).toEqual([older.session_id, startedEv.session_id]);
  const desc = await (await fetch(`${url}/sessions?sort=started&order=desc`)).json() as any;
  expect(desc.sessions.map((s: any) => s.session_id)).toEqual([startedEv.session_id, older.session_id]);
  server.stop();
});

test("GET /sessions rejects invalid sort/order/status with 400", async () => {
  const { server, url } = makeServer();
  expect((await fetch(`${url}/sessions?sort=bogus`)).status).toBe(400);
  expect((await fetch(`${url}/sessions?order=sideways`)).status).toBe(400);
  expect((await fetch(`${url}/sessions?status=bogus`)).status).toBe(400);
  server.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/hub/tests/server.test.ts`
Expected: the three new tests FAIL (params ignored → wrong content / 200 instead of 400).

- [ ] **Step 3: Implement**

In `packages/hub/src/server.ts`, extend the protocol import (line 4):

```typescript
import { validateIngestEnvelope, validateKnownPayload, AGMUX_VERSION, expandStatusFilter } from "@agmux/protocol";
import type { SessionStatus } from "@agmux/protocol";
```

Replace the `GET /sessions` block (lines 43–59) with:

```typescript
      if (m === "GET" && url.pathname === "/sessions") {
        // Status filter is opt-in (?status=<group|csv>; ?live=1 is the legacy
        // alias for status=open). Default returns all statuses so recently-ended
        // sessions remain discoverable for `agmux attach`.
        const live = url.searchParams.get("live") === "1";
        const agent_kind = url.searchParams.get("agent_kind") ?? undefined;
        const profile = url.searchParams.get("profile") ?? undefined;
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const sort = url.searchParams.get("sort") ?? undefined;
        const order = url.searchParams.get("order") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        if (sort !== undefined && sort !== "started" && sort !== "activity")
          return Response.json({ error: "invalid_sort" }, { status: 400 });
        if (order !== undefined && order !== "asc" && order !== "desc")
          return Response.json({ error: "invalid_order" }, { status: 400 });
        let statuses: SessionStatus[] | undefined;
        if (status !== undefined) {
          const expanded = expandStatusFilter(status);
          if (!expanded) return Response.json({ error: "invalid_status" }, { status: 400 });
          statuses = expanded;
        }
        const sessions = store.listSessions({
          live,
          statuses,
          agent_kind,
          profile,
          since,
          sort,
          order,
          limit: limit ? Number(limit) : undefined,
        });
        return Response.json({ sessions });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/hub`
Expected: PASS, all hub tests.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/server.ts packages/hub/tests/server.test.ts
git commit -m "hub: /sessions sort, order, status params"
```

---

### Task 4: Wrapper — `[ls]` config section + `loadLsConfig`

**Files:**
- Modify: `packages/wrapper/src/profile.ts`
- Test: `packages/wrapper/tests/profile.test.ts` (extend)

`loadLsConfig` parses **only** the `[ls]` table — deliberately not via `parseConfig` — so a broken `[profiles.*]` entry can't take `ls` down (today `ls` doesn't read the config at all; that resilience must not regress). Missing file or section → `{}` (built-in defaults apply); invalid values throw loudly so typos don't masquerade as defaults.

- [ ] **Step 1: Write the failing tests**

Append to `packages/wrapper/tests/profile.test.ts` (the file already imports `fs`, `os`, `path` and has the `tmp` `beforeEach`):

```typescript
import { loadLsConfig, parseLsSection } from "../src/profile.ts";

test("parseLsSection reads all keys", () => {
  expect(parseLsSection({ limit: 5, sort: "activity", asc: true, reverse: true, status: "open" }))
    .toEqual({ limit: 5, sort: "activity", asc: true, reverse: true, status: "open" });
});

test("parseLsSection: absent section and absent keys → empty defaults", () => {
  expect(parseLsSection(undefined)).toEqual({});
  expect(parseLsSection({})).toEqual({});
});

test("parseLsSection rejects invalid values loudly", () => {
  expect(() => parseLsSection({ sort: "foo" })).toThrow(/sort/);
  expect(() => parseLsSection({ limit: 0 })).toThrow(/limit/);
  expect(() => parseLsSection({ limit: "5" })).toThrow(/limit/);
  expect(() => parseLsSection({ asc: "yes" })).toThrow(/asc/);
  expect(() => parseLsSection({ reverse: 1 })).toThrow(/reverse/);
  expect(() => parseLsSection({ status: "bogus" })).toThrow(/status/);
});

test("loadLsConfig: missing file → {}; [ls] section parsed; broken profiles ignored", () => {
  expect(loadLsConfig(path.join(tmp, "nope.toml"))).toEqual({});
  const f = path.join(tmp, "config.toml");
  fs.writeFileSync(f, `[profiles.broken]\nagent_kind = "magic"\n\n[ls]\nlimit = 5\nsort = "activity"\n`);
  expect(loadLsConfig(f)).toEqual({ limit: 5, sort: "activity" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/wrapper/tests/profile.test.ts`
Expected: FAIL — `loadLsConfig`/`parseLsSection` not exported.

- [ ] **Step 3: Implement**

In `packages/wrapper/src/profile.ts`, extend the protocol import (line 4):

```typescript
import { expandStatusFilter, type AgentKind } from "@agmux/protocol";
```

Append to the file:

```typescript
// Display defaults for `agmux ls` ([ls] section). Precedence is resolved by
// the CLI: flag > config > built-in default.
export interface LsConfig {
  limit?: number;
  sort?: "started" | "activity";
  asc?: boolean;
  reverse?: boolean;
  status?: string; // group alias or comma-separated statuses (pre-validated)
}

export function parseLsSection(raw: unknown): LsConfig {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) throw new Error("[ls] must be a table");
  const r = raw as Record<string, unknown>;
  const out: LsConfig = {};
  if (r.limit !== undefined) {
    if (typeof r.limit !== "number" || !Number.isInteger(r.limit) || r.limit < 1)
      throw new Error(`[ls] limit must be a positive integer, got ${JSON.stringify(r.limit)}`);
    out.limit = r.limit;
  }
  if (r.sort !== undefined) {
    if (r.sort !== "started" && r.sort !== "activity")
      throw new Error(`[ls] sort must be 'started' or 'activity', got ${JSON.stringify(r.sort)}`);
    out.sort = r.sort;
  }
  if (r.asc !== undefined) {
    if (typeof r.asc !== "boolean") throw new Error(`[ls] asc must be a boolean, got ${JSON.stringify(r.asc)}`);
    out.asc = r.asc;
  }
  if (r.reverse !== undefined) {
    if (typeof r.reverse !== "boolean") throw new Error(`[ls] reverse must be a boolean, got ${JSON.stringify(r.reverse)}`);
    out.reverse = r.reverse;
  }
  if (r.status !== undefined) {
    if (typeof r.status !== "string" || expandStatusFilter(r.status) === null)
      throw new Error(`[ls] status must be active|open|closed or comma-separated statuses, got ${JSON.stringify(r.status)}`);
    out.status = r.status;
  }
  return out;
}

// Parses ONLY the [ls] table so a broken [profiles.*] entry can't break `ls`.
// Missing file or section → {} (built-in defaults). Invalid values throw.
export function loadLsConfig(configPath: string): LsConfig {
  if (!fs.existsSync(configPath)) return {};
  const raw = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  return parseLsSection(raw.ls);
}
```

Check `packages/wrapper/src/index.ts`: if it re-exports from `./profile.ts` selectively, add `LsConfig`, `parseLsSection`, `loadLsConfig`; if it uses `export *`, nothing to do.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/wrapper`
Expected: PASS, all wrapper tests.

- [ ] **Step 5: Commit**

```bash
git add packages/wrapper/src/profile.ts packages/wrapper/tests/profile.test.ts
git commit -m "wrapper: [ls] config section"
```

(Include `packages/wrapper/src/index.ts` in the `git add` if it was changed.)

---

### Task 5: CLI — `parse-ls.ts` with flag > config > default precedence

**Files:**
- Create: `packages/cli/src/parse-ls.ts`
- Test: `packages/cli/tests/parse-ls.test.ts` (create)

`--desc` and `--no-reverse` exist as CLI counterparts so a config default (`asc = true`, `reverse = true`) can still be overridden per-invocation — boolean flags alone can only push one direction.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/tests/parse-ls.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { parseLsArgs } from "../src/parse-ls.ts";

function ok(argv: string[], defaults = {}) {
  const r = parseLsArgs(argv, defaults);
  if (r.kind !== "ok") throw new Error(`expected ok, got: ${r.message}`);
  return r.opts;
}

test("built-in defaults with no flags and no config", () => {
  expect(ok([])).toEqual({
    limit: 50, sort: "started", asc: false, reverse: false,
    status: undefined, agent: undefined, profile: undefined,
  });
});

test("flags parse in space and = forms", () => {
  const o = ok(["-n", "5", "--sort=activity", "--asc", "-r", "--status", "active", "--agent=claude", "--profile", "work"]);
  expect(o).toEqual({
    limit: 5, sort: "activity", asc: true, reverse: true,
    status: "active", agent: "claude", profile: "work",
  });
});

test("config supplies defaults; flags win over config", () => {
  const defaults = { limit: 10, sort: "activity" as const, asc: true, reverse: true, status: "open" };
  expect(ok([], defaults)).toEqual({
    limit: 10, sort: "activity", asc: true, reverse: true,
    status: "open", agent: undefined, profile: undefined,
  });
  const o = ok(["-n", "3", "--sort", "started", "--desc", "--no-reverse", "--status", "closed"], defaults);
  expect(o).toEqual({
    limit: 3, sort: "started", asc: false, reverse: false,
    status: "closed", agent: undefined, profile: undefined,
  });
});

test("--all means uncapped; explicit -n wins over --all and over config", () => {
  expect(ok(["--all"]).limit).toBe(10000);
  expect(ok(["--all", "-n", "5"]).limit).toBe(5);
  expect(ok(["--all"], { limit: 10 }).limit).toBe(10000); // flag beats config
});

test("--live is an alias for --status open; explicit --status wins", () => {
  expect(ok(["--live"]).status).toBe("open");
  expect(ok(["--live"], { status: "closed" }).status).toBe("open"); // flag beats config
  expect(ok(["--live", "--status", "closed"]).status).toBe("closed");
});

test("invalid values error", () => {
  expect(parseLsArgs(["--sort", "size"], {}).kind).toBe("error");
  expect(parseLsArgs(["-n", "zero"], {}).kind).toBe("error");
  expect(parseLsArgs(["-n", "0"], {}).kind).toBe("error");
  expect(parseLsArgs(["--status", "bogus"], {}).kind).toBe("error");
  expect(parseLsArgs(["--frobnicate"], {}).kind).toBe("error");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/tests/parse-ls.test.ts`
Expected: FAIL — module `../src/parse-ls.ts` does not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/parse-ls.ts`:

```typescript
import { expandStatusFilter } from "@agmux/protocol";
import type { LsConfig } from "@agmux/wrapper";

// Fully resolved ls options (flag > config > built-in default).
export interface LsQueryOpts {
  limit: number;
  sort: "started" | "activity";
  asc: boolean;
  reverse: boolean;   // display-only: flip rows top↔bottom after sort+limit
  status?: string;    // group alias or comma list, validated; undefined = all
  agent?: string;
  profile?: string;
}

export type ParsedLs =
  | { kind: "ok"; opts: LsQueryOpts }
  | { kind: "error"; message: string };

const DEFAULT_LIMIT = 50;
const ALL_LIMIT = 10000;

export function parseLsArgs(argv: string[], defaults: LsConfig): ParsedLs {
  let limit: number | undefined;
  let all = false;
  let sort: "started" | "activity" | undefined;
  let asc: boolean | undefined;
  let reverse: boolean | undefined;
  let status: string | undefined;
  let live = false;
  let agent: string | undefined;
  let profile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    // value flags accept both `--flag value` and `--flag=value`
    const take = (): string | undefined => (eq >= 0 ? a.slice(eq + 1) : argv[++i]);
    switch (name) {
      case "-n": case "--limit": {
        const v = take();
        const num = v === undefined ? NaN : Number(v);
        if (!Number.isInteger(num) || num < 1)
          return { kind: "error", message: `ls: ${name} requires a positive integer` };
        limit = num; break;
      }
      case "--all": all = true; break;
      case "--sort": {
        const v = take();
        if (v !== "started" && v !== "activity")
          return { kind: "error", message: "ls: --sort must be 'started' or 'activity'" };
        sort = v; break;
      }
      case "--asc": asc = true; break;
      case "--desc": asc = false; break;
      case "-r": case "--reverse": reverse = true; break;
      case "--no-reverse": reverse = false; break;
      case "--status": {
        const v = take();
        if (!v || expandStatusFilter(v) === null)
          return { kind: "error", message: "ls: --status must be active|open|closed or comma-separated statuses (idle,running,waiting,ended,lost)" };
        status = v; break;
      }
      case "--live": live = true; break;
      case "--agent": {
        const v = take();
        if (!v) return { kind: "error", message: "ls: --agent requires a value" };
        agent = v; break;
      }
      case "--profile": {
        const v = take();
        if (!v) return { kind: "error", message: "ls: --profile requires a value" };
        profile = v; break;
      }
      default:
        return { kind: "error", message: `ls: unknown flag ${a}` };
    }
  }

  return {
    kind: "ok",
    opts: {
      limit: limit ?? (all ? ALL_LIMIT : defaults.limit ?? DEFAULT_LIMIT),
      sort: sort ?? defaults.sort ?? "started",
      asc: asc ?? defaults.asc ?? false,
      reverse: reverse ?? defaults.reverse ?? false,
      status: status ?? (live ? "open" : defaults.status),
      agent,
      profile,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/tests/parse-ls.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parse-ls.ts packages/cli/tests/parse-ls.test.ts
git commit -m "cli: parse ls flags with config defaults"
```

---

### Task 6: CLI — `ls.ts` query building + reverse rendering

**Files:**
- Modify: `packages/cli/src/ls.ts` (full rewrite of `LsOpts`/`lsCmd`/`printTable`)
- Test: `packages/cli/tests/ls.test.ts` (create)

`formatTable` becomes a pure function returning lines (testable); `-r` flips the data rows only — the header stays on top.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/tests/ls.test.ts`:

```typescript
import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { buildLsQuery, formatTable } from "../src/ls.ts";

function mkRow(sid: string, start: string): SessionRow {
  return {
    session_id: sid, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: start, last_heartbeat_ts: null, end_ts: null,
    exit_code: null, signal: null, status: "running", origin: "native", turn_count: null,
  };
}

test("buildLsQuery maps resolved opts to hub params", () => {
  const qs = buildLsQuery({
    limit: 5, sort: "activity", asc: true, reverse: true,
    status: "open", agent: "claude", profile: "work",
  });
  expect(qs.get("limit")).toBe("5");
  expect(qs.get("sort")).toBe("activity");
  expect(qs.get("order")).toBe("asc");
  expect(qs.get("status")).toBe("open");
  expect(qs.get("agent_kind")).toBe("claude");
  expect(qs.get("profile")).toBe("work");
});

test("buildLsQuery omits absent filters and maps desc", () => {
  const qs = buildLsQuery({ limit: 50, sort: "started", asc: false, reverse: false });
  expect(qs.get("order")).toBe("desc");
  expect(qs.get("status")).toBeNull();
  expect(qs.get("agent_kind")).toBeNull();
  expect(qs.get("profile")).toBeNull();
});

test("formatTable: reverse flips data rows but keeps the header on top", () => {
  const rows = [mkRow("aaaa", "2026-06-10T11:00:00.000Z"), mkRow("bbbb", "2026-06-10T10:00:00.000Z")];
  const plain = formatTable(rows, false);
  expect(plain[0]).toStartWith("ID");
  expect(plain[1]).toStartWith("aaaa");
  expect(plain[2]).toStartWith("bbbb");
  const flipped = formatTable(rows, true);
  expect(flipped[0]).toStartWith("ID");
  expect(flipped[1]).toStartWith("bbbb");
  expect(flipped[2]).toStartWith("aaaa");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/tests/ls.test.ts`
Expected: FAIL — `buildLsQuery`/`formatTable` not exported.

- [ ] **Step 3: Implement**

Replace the contents of `packages/cli/src/ls.ts` with:

```typescript
import type { SessionRow } from "@agmux/protocol";
import type { LsQueryOpts } from "./parse-ls.ts";

export interface LsOpts extends LsQueryOpts {
  hubUrl: string;
}

export function buildLsQuery(opts: LsQueryOpts): URLSearchParams {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.agent) qs.set("agent_kind", opts.agent);
  if (opts.profile) qs.set("profile", opts.profile);
  qs.set("sort", opts.sort);
  qs.set("order", opts.asc ? "asc" : "desc");
  qs.set("limit", String(opts.limit));
  return qs;
}

export async function lsCmd(opts: LsOpts): Promise<number> {
  const r = await fetch(`${opts.hubUrl}/sessions?${buildLsQuery(opts).toString()}`);
  if (!r.ok) { console.error(`hub error ${r.status}`); return 1; }
  const { sessions } = (await r.json()) as { sessions: SessionRow[] };
  for (const line of formatTable(sessions, opts.reverse)) console.log(line);
  return 0;
}

export function formatTable(rows: SessionRow[], reverse: boolean): string[] {
  const header = ["ID", "AGENT", "PROFILE", "STATUS", "TURNS", "PID", "TMUX", "START", "LAST_SEEN"];
  const data = rows.map((r) => [
    r.session_id.slice(0, 23),
    r.agent_kind,
    r.profile ?? "-",
    r.status,
    // "-" = no adapter observation; "0" = adapter watched but no turn happened
    // (nothing to resume); >0 = a real conversation.
    r.turn_count == null ? "-" : String(r.turn_count),
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

- [ ] **Step 4: Run tests — `bin/agmux.ts` now has a type error; that is expected**

Run: `bun test packages/cli/tests/ls.test.ts`
Expected: PASS (3 tests). Note: `bin/agmux.ts` still calls `lsCmd` with the old options shape — it is fixed in Task 7, and the two tasks should be committed back-to-back. `bun test` does not typecheck `bin/`, so tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ls.ts packages/cli/tests/ls.test.ts
git commit -m "cli: ls query building + reverse rendering"
```

---

### Task 7: CLI — wire `bin/agmux.ts` and update `usage()`

**Files:**
- Modify: `packages/cli/bin/agmux.ts:19` (import), `:34` (usage line), `:138-148` (ls case)

- [ ] **Step 1: Implement**

In `packages/cli/bin/agmux.ts`:

1. Extend the wrapper import (line 19):

```typescript
import { loadProfile, loadLsConfig, type LsConfig } from "@agmux/wrapper";
```

2. Add the parse-ls import next to the other `../src/` imports:

```typescript
import { parseLsArgs } from "../src/parse-ls.ts";
```

3. Replace the `ls` line in `usage()` (line 34) with:

```
  ls [-n <num>|--all] [--sort <started|activity>] [--asc|--desc] [-r/--reverse]
     [--status <active|open|closed|s1,s2,...>] [--live] [--agent <kind>] [--profile <name>]
     defaults configurable in ~/.config/agmux/config.toml under [ls]
```

(Keep the surrounding template-literal formatting; these are three lines inside the existing usage string.)

4. Replace the `case "ls"` block (lines 138–148) with:

```typescript
    case "ls": {
      const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
      let lsDefaults: LsConfig;
      try { lsDefaults = loadLsConfig(configPath); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
      const parsed = parseLsArgs(argv.slice(1), lsDefaults);
      if (parsed.kind === "error") { console.error(parsed.message); return 2; }
      return lsCmd({ ...parsed.opts, hubUrl });
    }
```

- [ ] **Step 2: Typecheck and run the full unit test suite**

Run: `bun run typecheck && bun test packages`
Expected: typecheck clean; all package tests PASS.

- [ ] **Step 3: Smoke-test by hand**

Run: `bun packages/cli/bin/agmux.ts ls --sort bogus`
Expected: prints `ls: --sort must be 'started' or 'activity'`, exit code 2.

Run: `bun packages/cli/bin/agmux.ts ls -n 3 -r` (against the real hub)
Expected: header + up to 3 rows, newest at the bottom.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/bin/agmux.ts
git commit -m "cli: wire ls flags + usage"
```

---

### Task 8: Docs + e2e verification

**Files:**
- Modify: `README.md:67-69` (ls examples) and the paragraph after the CLI code fence
- Test: `tests/e2e/run-ls-attach-kill.test.ts` (run only — `--live` and default `ls` must stay green)

- [ ] **Step 1: Update README**

Replace lines 67–69:

```
agmux ls                     # recent 50 sessions (any status) — newest first
agmux ls --live              # only live sessions (idle/running/waiting)
agmux ls --all               # uncapped
```

with:

```
agmux ls                     # recent 50 sessions (any status) — newest first
agmux ls -n 5 -r             # 5 most recent, newest at the bottom (above your prompt)
agmux ls --sort activity     # order by last activity instead of start time (--asc to flip)
agmux ls --status active     # active (running|waiting), open (+idle), closed (ended|lost), or raw statuses
agmux ls --all               # uncapped   (--live = alias for --status open)
```

After the code fence that contains these examples (closes at line 73), add:

```markdown
`ls` defaults are configurable in `~/.config/agmux/config.toml` (CLI flags win):

```toml
[ls]
limit = 10
sort = "activity"   # started | activity
asc = false
reverse = true      # newest at the bottom
status = "open"     # active | open | closed | comma-separated statuses
```
```

- [ ] **Step 2: Run the full suite including e2e**

Run: `bun test`
Expected: PASS — including `tests/e2e/run-ls-attach-kill.test.ts` (needs tmux available, ~30s budget).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: ls sorting/filtering options"
```
