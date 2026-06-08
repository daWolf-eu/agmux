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
