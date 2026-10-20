import { test, expect } from "bun:test";
import { NO_SESSION_ID } from "@agmux/protocol";
import { Store } from "../src/index.ts";

const transport = { kind: "openshell", gateway: "gw", target: "sbx", bin: "openshell" } as const;
const TS = "2026-06-08T00:00:00.000Z";
const NOW = new Date("2026-06-08T00:00:05.000Z");
const REMOTE = "0190a3e0-0000-7000-8000-000000000001";
const LOCAL = "0190a3e0-0000-7000-8000-000000000002";
let n = 0;

function hev(kind: string, ts: string, payload: unknown): any {
  return { event_id: "h" + ++n, ts, session_id: NO_SESSION_ID, kind, version: 1, host: "gw/sbx", payload };
}
const synced = (db_id = "db1", ts = TS) => hev("host.synced", ts, {
  remote: "gw/sbx", transport, cursor: 1, db_id, agmux_version: "0.1.0", replication: 1, rejected: 0,
});
function registered(sid: string, host: string): any {
  return {
    event_id: "r" + ++n, ts: TS, session_id: sid, kind: "session.registered", version: 1, host,
    payload: { agent_kind: "claude", tmux_session: "main", tmux_window: "1", tmux_pane: "%3",
      cwd: "/tmp", profile: null, agent_version: null, parent: null, native_session_id: null, pid: 42 },
  };
}
const ended = (sid: string, host: string): any => ({
  event_id: "x" + ++n, ts: TS, session_id: sid, kind: "session.ended", version: 1, host,
  payload: { exit_code: 0, signal: null },
});

function setup(): Store {
  const s = Store.openInMemory();
  s.append(synced());
  s.appendReplicated(registered(REMOTE, "gw/sbx"), "gw/sbx", "db1");
  s.append(registered(LOCAL, "mac.local"));
  return s;
}

test("remote rows are flagged", () => {
  const s = setup();
  const r = s.getSession(REMOTE, NOW)!;
  expect(r.remote).toBe(true);
  expect(r.sync_stale).toBe(false);
  expect(r.last_sync_ts).toBe(TS);
  const l = s.getSession(LOCAL, NOW)!;
  expect(l.remote).toBe(false);
  expect(l.sync_stale).toBe(false);
  expect(l.last_sync_ts).toBeNull();
});

test("remote rows expose no pid or tmux coords", () => {
  const s = setup();
  const r = s.getSession(REMOTE, NOW)!;
  expect(r.pid).toBeNull();
  expect(r.tmux_pane).toBeNull();
  expect(r.tmux_session).toBeNull();
  expect(r.tmux_window).toBeNull();
  expect(r.tmux_socket).toBeNull();
  expect(s.listSessions({ now: NOW }).find((x) => x.session_id === REMOTE)!.pid).toBeNull();
  const payload = s.listEvents({ session_id: REMOTE })[0]!.payload as any;
  expect(payload.pid).toBe(42);
  expect(payload.tmux_pane).toBe("%3");
  expect(s.getSession(LOCAL, NOW)!.pid).toBe(42);
});

test("sync_failed marks rows stale", () => {
  const s = setup();
  const before = s.getSession(REMOTE, NOW)!.status;
  s.append(hev("host.sync_failed", "2026-06-08T00:00:02.000Z", { remote: "gw/sbx", error: "boom" }));
  const r = s.getSession(REMOTE, NOW)!;
  expect(r.sync_stale).toBe(true);
  expect(r.status).toBe(before);
});

test("host.removed derives lost with rule host-removed", () => {
  const s = setup();
  s.append(hev("host.removed", "2026-06-08T00:00:03.000Z", { remote: "gw/sbx" }));
  const d = s.explainSession(REMOTE, NOW)!;
  expect(d.status).toBe("lost");
  expect(d.rule).toBe("host-removed");
  expect(d.reason).toBe("host gw/sbx removed at 2026-06-08T00:00:03.000Z");
  expect(s.getSession(REMOTE, NOW)!.status).toBe("lost");
});

test("host.removed leaves an ended row ended", () => {
  const s = Store.openInMemory();
  s.append(synced());
  s.appendReplicated(registered(REMOTE, "gw/sbx"), "gw/sbx", "db1");
  s.appendReplicated(ended(REMOTE, "gw/sbx"), "gw/sbx", "db1");
  s.append(hev("host.removed", "2026-06-08T00:00:03.000Z", { remote: "gw/sbx" }));
  const d = s.explainSession(REMOTE, NOW)!;
  expect(d.status).toBe("ended");
  expect(d.rule).toBe("terminal");
});

test("listSessions locality and host filters", () => {
  const s = setup();
  const ids = (o: object) => s.listSessions({ now: NOW, ...o }).map((r) => r.session_id);
  expect(ids({ locality: "remote" })).toEqual([REMOTE]);
  expect(ids({ locality: "local" })).toEqual([LOCAL]);
  expect(ids({ host: "gw/*" })).toEqual([REMOTE]);
  expect(ids({ host: "mac.*" })).toEqual([LOCAL]);
  expect(ids({}).sort()).toEqual([REMOTE, LOCAL].sort());
});

test("liveness candidates exclude remote rows", () => {
  const s = Store.openInMemory();
  s.append(synced());
  const ev = registered(REMOTE, "gw/sbx");
  ev.payload.native_session_id = "n-1";
  s.appendReplicated(ev, "gw/sbx", "db1");
  expect(s.listLiveNativeSessions("mac.local").map((r) => r.session_id)).not.toContain(REMOTE);
  expect(s.listLiveNativeSessions("gw/sbx")).toEqual([]);
});

const NEW = "0190a3e0-0000-7000-8000-000000000003";
const OLD_DB = "11111111-aaaa-4000-8000-000000000000";
const NEW_DB = "22222222-bbbb-4000-8000-000000000000";

function incarnation(removedFirst: boolean): Store {
  const s = Store.openInMemory();
  s.append(synced(OLD_DB));
  s.appendReplicated(registered(REMOTE, "gw/sbx"), "gw/sbx", OLD_DB);
  if (removedFirst) s.append(hev("host.removed", "2026-06-08T00:00:03.000Z", { remote: "gw/sbx" }));
  s.append(synced(NEW_DB, "2026-06-08T00:00:04.000Z"));
  s.appendReplicated(registered(NEW, "gw/sbx"), "gw/sbx", NEW_DB);
  return s;
}

for (const removedFirst of [true, false]) {
  test(`a recreated host (new db_id${removedFirst ? ", after host.removed" : ", deletion missed"}) leaves the old incarnation lost`, () => {
    const s = incarnation(removedFirst);
    const d = s.explainSession(REMOTE, NOW)!;
    expect(d).toMatchObject({ status: "lost", rule: "host-reset", reason: "host gw/sbx was recreated (db 11111111 → 22222222)" });
    expect(s.getSession(REMOTE, NOW)!.status).toBe("lost");
    expect(s.explainSession(NEW, NOW)!.rule).toBe("stored");
    expect(s.getSession(NEW, NOW)!.status).toBe("idle");
    expect(s.listSessions({ now: NOW, live: true }).map((r) => r.session_id)).not.toContain(REMOTE);
  });
}

test("rebuildProjections reproduces source_db and the host-reset rule", () => {
  const s = incarnation(false);
  s.rebuildProjections();
  expect(s.explainSession(REMOTE, NOW)!.rule).toBe("host-reset");
  expect(s.getSession(NEW, NOW)!.status).toBe("idle");
  const rows = s.rawDb().query<{ session_id: string; source_db: string | null }, []>(
    "SELECT session_id, source_db FROM sessions ORDER BY session_id").all();
  expect(rows).toEqual([{ session_id: REMOTE, source_db: OLD_DB }, { session_id: NEW, source_db: NEW_DB }]);
});

test("the latest replicated event's db wins; a same-db reconnect after removal reverts to live", () => {
  const s = Store.openInMemory();
  s.append(synced(OLD_DB));
  s.appendReplicated(registered(REMOTE, "gw/sbx"), "gw/sbx", OLD_DB);
  s.append(hev("host.removed", "2026-06-08T00:00:03.000Z", { remote: "gw/sbx" }));
  expect(s.explainSession(REMOTE, NOW)!.rule).toBe("host-removed");
  s.append(synced(OLD_DB, "2026-06-08T00:00:04.000Z"));
  expect(s.explainSession(REMOTE, NOW)!.rule).toBe("stored");
});

test("rows without source_db (local, pre-v10) never derive host-reset", () => {
  const s = Store.openInMemory();
  s.append(synced(OLD_DB));
  s.appendReplicated(registered(REMOTE, "gw/sbx"), "gw/sbx", OLD_DB);
  s.rawDb().exec("UPDATE sessions SET source_db = NULL");
  s.append(synced(NEW_DB, "2026-06-08T00:00:04.000Z"));
  expect(s.explainSession(REMOTE, NOW)!.rule).toBe("stored");
  s.append(registered(LOCAL, "mac.local"));
  expect(s.rawDb().query("SELECT source_db FROM events WHERE session_id = ?").get(LOCAL)).toEqual({ source_db: null });
});
