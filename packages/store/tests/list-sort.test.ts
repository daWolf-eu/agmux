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
