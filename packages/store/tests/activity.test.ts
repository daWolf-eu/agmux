import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

function makeStore() { return Store.openInMemory(); }

const sid = "0190a3e0-0000-7000-8000-000000000000";
const t0 = "2026-05-28T12:00:00.000Z";
const t1 = "2026-05-28T12:00:30.000Z";
const t2 = "2026-05-28T12:01:00.000Z";

const startedEv = {
  event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
  ts: t0,
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

function lastHeartbeat(s: Store): string | null {
  return s.rawDb()
    .query<{ last_heartbeat_ts: string | null }, [string]>(
      `SELECT last_heartbeat_ts FROM sessions WHERE session_id = ?`,
    )
    .get(sid)?.last_heartbeat_ts ?? null;
}

test("turn.started bumps last_heartbeat_ts to the event ts", () => {
  const s = makeStore();
  s.append(startedEv);
  expect(lastHeartbeat(s)).toBeNull(); // session.started leaves it NULL
  s.append({
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q",
    ts: t1, session_id: sid,
    kind: "turn.started", version: 1, host: "macbook.local",
    payload: {},
  });
  expect(lastHeartbeat(s)).toBe(t1);
});

test("input.required advances last_heartbeat_ts (waiting transition)", () => {
  const s = makeStore();
  s.append(startedEv);
  s.append({
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q",
    ts: t1, session_id: sid,
    kind: "turn.started", version: 1, host: "macbook.local",
    payload: {},
  });
  s.append({
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2R",
    ts: t2, session_id: sid,
    kind: "input.required", version: 1, host: "macbook.local",
    payload: { kind: "prompt" },
  });
  expect(lastHeartbeat(s)).toBe(t2);
});

test("ended guard: a stray turn.started updates neither status nor last_heartbeat_ts", () => {
  const s = makeStore();
  s.append(startedEv);
  s.append({
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q",
    ts: t1, session_id: sid,
    kind: "turn.started", version: 1, host: "macbook.local",
    payload: {},
  });
  s.append({
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2R",
    ts: t2, session_id: sid,
    kind: "session.ended", version: 1, host: "macbook.local",
    payload: { exit_code: 0, signal: null, reason: "normal" },
  });
  // Stray adapter event after death must be inert.
  s.append({
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2S",
    ts: "2026-05-28T12:02:00.000Z", session_id: sid,
    kind: "turn.started", version: 1, host: "macbook.local",
    payload: {},
  });
  const row = s.rawDb()
    .query<{ status: string; last_heartbeat_ts: string | null }, [string]>(
      `SELECT status, last_heartbeat_ts FROM sessions WHERE session_id = ?`,
    )
    .get(sid);
  expect(row?.status).toBe("ended");
  expect(row?.last_heartbeat_ts).toBe(t1); // unchanged from the pre-death turn
});
