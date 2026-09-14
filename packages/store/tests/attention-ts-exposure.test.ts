import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { listSessions, getSessionRaw } from "../src/queries.ts";

function db0(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  applyEventToProjection(db, {
    event_id: "e0", ts: "2026-09-11T10:00:00.000Z", session_id: "s1", kind: "session.started",
    version: 1, host: "h",
    payload: { agent_kind: "claude", command: "claude", args: [], env_overrides: {}, cwd: "/tmp", host: "h" },
  } as any);
  return db;
}

let n = 0;
function ev(db: Database, kind: string, ts: string, payload: any = {}) {
  applyEventToProjection(db, { event_id: `e-${n++}`, ts, session_id: "s1", kind, version: 1, host: "h", payload } as any);
}

// Reads stay within LOST_THRESHOLD_MS (60s) of the last heartbeat: tool.used does
// not refresh the heartbeat, so a distant `now` would compute status "lost" and
// mask the stale-`waiting` this test is about.
const row = (db: Database, now = "2026-09-11T10:01:40.000Z") =>
  listSessions(db, { now: new Date(now) })[0]!;

// The notification debounce keys its episode on attention_ts, so the field has to
// survive the join out of session_activity — it is not enough for the projection
// to store it. Without this, every row reads attention_ts = undefined and every
// session collapses into one shared "" episode.
test("attention_ts is exposed on listed rows", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  expect(row(db).attention_ts).toBe("2026-09-11T10:01:00.000Z");
});

test("attention_ts is exposed on a single fetched row", () => {
  const db = db0();
  ev(db, "turn.ended", "2026-09-11T10:01:00.000Z", {});
  const r = getSessionRaw(db, "s1", new Date("2026-09-11T10:01:40.000Z"))!;
  expect(r.attention_ts).toBe("2026-09-11T10:01:00.000Z");
});

test("attention_ts is null before anything has wanted attention", () => {
  expect(row(db0()).attention_ts).toBeNull();
});

// The crux of the notification-spam bug: tool.used must move activity_ts (it
// drives the dash ACTIVITY column) while leaving attention_ts alone, so a busy
// session cannot manufacture new attention episodes by running tools.
test("tool.used moves activity_ts but never attention_ts", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  const before = row(db);

  for (const [i, ts] of ["10:01:10", "10:01:20", "10:01:30"].entries()) {
    ev(db, "tool.used", `2026-09-11T${ts}.000Z`, { tool: `T${i}` });
  }
  const after = row(db);

  expect(after.attention_ts).toBe(before.attention_ts);
  expect(after.activity_ts).not.toBe(before.activity_ts);
  expect(after.activity_ts).toBe("2026-09-11T10:01:30.000Z");
  // Nothing cleared the wait, which is exactly why the episode must not move:
  // no adapter emits input.received, so the row is still `waiting`.
  expect(after.status).toBe("waiting");
  expect(after.last_input_kind).toBe("permission");
});

test("a later attention event does move attention_ts", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  ev(db, "tool.used", "2026-09-11T10:01:10.000Z", { tool: "Bash" });
  ev(db, "turn.ended", "2026-09-11T10:01:20.000Z", {});
  expect(row(db).attention_ts).toBe("2026-09-11T10:01:20.000Z");
});
