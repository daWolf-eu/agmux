import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

function makeStore() { return Store.openInMemory(); }

const sid = "0190a3e0-0000-7000-8000-000000000000";
const startedEv = {
  event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
  ts: "2026-05-28T12:00:00.000Z",
  session_id: sid,
  kind: "session.started",
  version: 1,
  host: "macbook.local",
  payload: {
    agent_kind: "claude", profile: "claude-work", command: "ccc",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
    tmux_session: "agmux", tmux_window: "@1", tmux_pane: "%1", project: null,
  },
};

test("append() + projection: getSession returns the row", () => {
  const s = makeStore();
  s.append(startedEv);
  const row = s.getSession(sid, new Date("2026-05-28T12:00:10.000Z"));
  expect(row?.status).toBe("idle");
  expect(row?.command).toBe("ccc");
});

test("append() is idempotent on duplicate event_id", () => {
  const s = makeStore();
  expect(s.append(startedEv)).toBe(true);
  expect(s.append(startedEv)).toBe(false); // duplicate
  const events = s.listEvents({ session_id: sid });
  expect(events.length).toBe(1);
});

test("listSessions filters by status set; default returns live only", () => {
  const s = makeStore();
  s.append(startedEv);
  // a second, ended session
  const sid2 = "0190a3e0-0000-7000-8000-000000000001";
  s.append({ ...startedEv, event_id: "01HZ7P0K8WVQH8WGS8X9DC9F30", session_id: sid2 });
  s.append({
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F31",
    ts: "2026-05-28T12:05:00.000Z",
    session_id: sid2,
    kind: "session.ended", version: 1, host: "macbook.local",
    payload: { exit_code: 0, signal: null, reason: "normal" },
  });
  const liveOnly = s.listSessions({ live: true, now: new Date("2026-05-28T12:00:10.000Z") });
  expect(liveOnly.map((r) => r.session_id)).toEqual([sid]);
  const all = s.listSessions({ live: false, now: new Date("2026-05-28T12:00:10.000Z") });
  expect(all.length).toBe(2);
});

test("listSessions surfaces 'lost' lazily via computeEffectiveStatus", () => {
  const s = makeStore();
  s.append(startedEv);
  const rows = s.listSessions({ live: false, now: new Date("2026-05-28T12:02:00.000Z") });
  expect(rows[0]?.status).toBe("lost");
});

test("listEvents filters by session_id and orders ascending", () => {
  const s = makeStore();
  s.append(startedEv);
  s.append({
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q",
    ts: "2026-05-28T12:00:30.000Z",
    session_id: sid,
    kind: "session.heartbeat", version: 1, host: "macbook.local",
    payload: { pid_alive: true, winsize: { rows: 40, cols: 100 } },
  });
  const evs = s.listEvents({ session_id: sid });
  expect(evs.map((e) => e.kind)).toEqual(["session.started", "session.heartbeat"]);
});

test("rebuildProjections wipes sessions and replays from events", () => {
  const s = makeStore();
  s.append(startedEv);
  s.rawDb().exec(`UPDATE sessions SET command='WRONG' WHERE session_id='${sid}'`);
  s.rebuildProjections();
  const row = s.getSession(sid);
  expect(row?.command).toBe("ccc");
});

import { listLiveNativeSessions } from "../src/queries.ts";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";

test("listLiveNativeSessions returns only live native rows on this host with a pid", () => {
  const db = new Database(":memory:"); runMigrations(db);
  const ins = (sid: string, origin: string, status: string, pid: number | null, host: string) =>
    db.query(`INSERT INTO sessions (session_id, agent_kind, profile, native_session_id, command, args_json, env_json, cwd, pid, host, start_ts, status, origin)
              VALUES (?, 'claude', NULL, ?, 'claude', '[]', '{}', '/tmp', ?, ?, '2026-06-08T00:00:00.000Z', ?, ?)`)
      .run(sid, "nat-" + sid, pid, host, status, origin);
  ins("a", "native", "running", 100, "h");   // included
  ins("b", "native", "idle", 101, "h");       // included
  ins("c", "native", "ended", 102, "h");      // excluded: not live
  ins("d", "wrapper", "running", 103, "h");   // excluded: not native
  ins("e", "native", "running", null, "h");   // excluded: no pid
  ins("f", "native", "running", 104, "other");// excluded: other host

  const rows = listLiveNativeSessions(db, "h");
  expect(rows.map((r) => r.session_id).sort()).toEqual(["a", "b"]);
  expect(rows.find((r) => r.session_id === "a")!.pid).toBe(100);
});
