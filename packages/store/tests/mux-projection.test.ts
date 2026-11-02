import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { getSessionRaw } from "../src/queries.ts";

function freshDb() { const db = new Database(":memory:"); runMigrations(db); return db; }
function ev(sid: string, kind: string, payload: Record<string, unknown>) {
  return { event_id: `e-${sid}-${kind}-${Math.random()}`, ts: "2026-11-02T00:00:00.000Z", session_id: sid, kind, version: 1, host: "h", payload } as any;
}
const started = (extra: Record<string, unknown> = {}) => ({
  agent_kind: "claude", profile: null, command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
  tmux_session: "s", tmux_window: "0", tmux_pane: "%1", tmux_socket: "/sock", project: null, ...extra,
});
const reg = (extra: Record<string, unknown> = {}) => ({
  native_session_id: "n", agent_kind: "claude", pid: 1, cwd: "/tmp",
  tmux_session: null, tmux_window: null, tmux_pane: null, tmux_socket: null,
  profile: null, agent_version: null, parent: null, ...extra,
});
const row = (db: Database, sid: string) => db.query<any, [string]>(`SELECT * FROM sessions WHERE session_id=?`).get(sid);

test("old tmux events replay with mux null", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started()));
  const r = row(db, "a");
  expect(r.mux).toBeNull();
  expect(r.mux_label).toBeNull();
  expect(r.tmux_socket).toBe("/sock");
  expect(getSessionRaw(db, "a", new Date())!.mux).toBeNull();
});

test("started with mux rex stores mux and label", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started({ mux: "rex", mux_label: "work / tab 2" })));
  const r = row(db, "a");
  expect(r.mux).toBe("rex");
  expect(r.mux_label).toBe("work / tab 2");
  expect(getSessionRaw(db, "a", new Date())!.mux_label).toBe("work / tab 2");
});

test("resumed from rex into tmux with null socket clears socket, mux and label", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started({ mux: "rex", mux_label: "L", tmux_socket: "/old" })));
  applyEventToProjection(db, ev("a", "session.resumed", {
    new_pid: 2, new_tmux_session: "t", new_tmux_window: "1", new_tmux_pane: "%2", new_tmux_socket: null, reason: "cli_attach_after_death",
  }));
  const r = row(db, "a");
  expect(r.tmux_socket).toBeNull();
  expect(r.mux).toBeNull();
  expect(r.mux_label).toBeNull();
  expect(r.tmux_session).toBe("t");
});

const resumed = (extra: Record<string, unknown> = {}) => ({
  new_pid: 2, new_tmux_session: "t", new_tmux_window: "1", new_tmux_pane: "%2", new_tmux_socket: null, reason: "cli_attach_after_death", ...extra,
});

test("resumed from tmux into rex clears tmux_server", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started()));
  db.query(`UPDATE sessions SET tmux_server='srv' WHERE session_id='a'`).run();
  applyEventToProjection(db, ev("a", "session.resumed", resumed({ new_mux: "rex", new_mux_label: "L" })));
  const r = row(db, "a");
  expect(r.mux).toBe("rex");
  expect(r.tmux_server).toBeNull();
});

test("resumed from rex into tmux clears tmux_server", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started({ mux: "rex", mux_label: "L" })));
  db.query(`UPDATE sessions SET tmux_server='srv' WHERE session_id='a'`).run();
  applyEventToProjection(db, ev("a", "session.resumed", resumed()));
  const r = row(db, "a");
  expect(r.mux).toBeNull();
  expect(r.tmux_server).toBeNull();
});

test("resumed with the same mux keeps tmux_server", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started()));
  db.query(`UPDATE sessions SET tmux_server='srv' WHERE session_id='a'`).run();
  applyEventToProjection(db, ev("a", "session.resumed", resumed()));
  expect(row(db, "a").tmux_server).toBe("srv");
});

test("registered: rex row, tmux payload with coords and null socket replaces all location fields", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started({ mux: "rex", mux_label: "L", tmux_socket: "/old" })));
  db.query(`UPDATE sessions SET tmux_server='srv' WHERE session_id='a'`).run();
  applyEventToProjection(db, ev("a", "session.registered", reg({ tmux_session: "t", tmux_window: "1", tmux_pane: "%2" })));
  const r = row(db, "a");
  expect([r.tmux_session, r.tmux_window, r.tmux_pane]).toEqual(["t", "1", "%2"]);
  expect(r.tmux_socket).toBeNull();
  expect(r.tmux_server).toBeNull();
  expect(r.mux).toBeNull();
  expect(r.mux_label).toBeNull();
});

test("registered: tmux row, rex payload replaces tmux_server with null", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started()));
  db.query(`UPDATE sessions SET tmux_server='srv' WHERE session_id='a'`).run();
  applyEventToProjection(db, ev("a", "session.registered", reg({ tmux_session: "rs", tmux_window: "w", tmux_pane: "p", mux: "rex", mux_label: "L" })));
  const r = row(db, "a");
  expect(r.tmux_server).toBeNull();
  expect(r.tmux_socket).toBeNull();
  expect(r.mux).toBe("rex");
  expect(r.mux_label).toBe("L");
});

test("registered: same mux keeps COALESCE (null socket keeps old socket)", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started()));
  applyEventToProjection(db, ev("a", "session.registered", reg({ tmux_session: "s2", tmux_pane: "%9" })));
  const r = row(db, "a");
  expect(r.tmux_socket).toBe("/sock");
  expect(r.tmux_session).toBe("s2");
  expect(r.mux).toBeNull();
});

test("registered: payload with no coords and no mux leaves a rex row untouched", () => {
  const db = freshDb();
  applyEventToProjection(db, ev("a", "session.started", started({ mux: "rex", mux_label: "L" })));
  applyEventToProjection(db, ev("a", "session.registered", reg()));
  const r = row(db, "a");
  expect(r.mux).toBe("rex");
  expect(r.mux_label).toBe("L");
  expect(r.tmux_session).toBe("s");
  expect(r.tmux_socket).toBe("/sock");
});
