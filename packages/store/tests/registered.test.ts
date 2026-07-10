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

test("mint: registered env_overrides is persisted into env_json", () => {
  const db = freshDb();
  applyEventToProjection(db, regEv("s-env", { native_session_id: "n-e", pid: 1, env_overrides: { CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax" } }));
  const r = row(db, "s-env");
  expect(JSON.parse(r.env_json)).toEqual({ CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax" });
});

test("mint: registered with no env_overrides stores an empty object", () => {
  const db = freshDb();
  applyEventToProjection(db, regEv("s-env0", { native_session_id: "n-e0", pid: 1 }));
  expect(JSON.parse(row(db, "s-env0").env_json)).toEqual({});
});
