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
