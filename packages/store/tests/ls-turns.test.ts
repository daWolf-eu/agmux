import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

const sid = "0190a3e0-0000-7000-8000-00000000c0de";
function ev(kind: string, id: string, payload: unknown = {}) {
  return { event_id: id, ts: "2026-06-03T10:00:00.000Z", session_id: sid, kind, version: 1, host: "h", payload } as any;
}

test("listSessions exposes turn_count from session_usage (null when no usage row)", () => {
  const store = Store.openInMemory();
  store.append(ev("session.started", "01HZ7P0K8WVQH8WGS8X9DCA001", {
    agent_kind: "claude", profile: null, command: "claude", args: [], env_overrides: {},
    cwd: "/tmp", pid: 1, tmux_session: null, tmux_window: null, tmux_pane: null, project: null,
  }));
  expect(store.listSessions()[0]!.turn_count).toBeNull();
  store.append(ev("turn.started", "01HZ7P0K8WVQH8WGS8X9DCA002"));
  store.append(ev("turn.ended", "01HZ7P0K8WVQH8WGS8X9DCA003"));
  store.append(ev("turn.started", "01HZ7P0K8WVQH8WGS8X9DCA004"));
  expect(store.listSessions()[0]!.turn_count).toBe(2);
  store.close();
});
