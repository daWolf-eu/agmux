import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

function reg(store: Store, nat: string, eid: string, ts: string) {
  store.resolveAndAppend({
    event_id: eid, ts, kind: "session.registered", version: 1, host: "h",
    identity: { agent_kind: "claude", native_session_id: nat },
    payload: { agent_kind: "claude", native_session_id: nat, pid: 100, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: null, profile: null, agent_version: null, parent: null },
  } as any);
}

test("native ended-then-usage is NOT frozen (origin native reopens cleanly)", () => {
  const store = Store.openInMemory();
  reg(store, "nat-1", "01HZ7P0K8WVQH8WGS8X9DC9F2A", "2026-06-09T10:00:00.000Z");
  const sid = store.listSessions({}).find((s) => s.native_session_id === "nat-1")!.session_id;
  // Force the row to 'ended' to prove ORIGIN (not status) gates the freeze.
  store.append({ event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2B", ts: "2026-06-09T10:01:00.000Z",
    session_id: sid, kind: "session.ended", version: 1, host: "h",
    payload: { exit_code: 0, signal: null, reason: "normal" } } as any);
  store.append({ event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2C", ts: "2026-06-09T10:02:00.000Z",
    session_id: sid, kind: "usage.reported", version: 1, host: "h",
    payload: { cumulative: false, source: "manual-command", input_tokens: 7 } } as any);
  expect(store.getSessionUsage(sid)!.input_tokens).toBe(7); // native: not frozen
  store.close();
});
