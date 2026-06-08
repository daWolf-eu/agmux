import { test, expect } from "bun:test";
import { Store } from "@agmux/store";
import { sweepNativeLiveness, buildLostEvent } from "../src/liveness.ts";

function nativeRow(store: Store, sid: string, pid: number, host = "h") {
  store.append({
    event_id: "reg-" + sid, ts: new Date().toISOString(), session_id: sid,
    kind: "session.registered", version: 1, host,
    payload: { agent_kind: "claude", native_session_id: "nat-" + sid, pid, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: null, profile: null, agent_version: null, parent: null },
  } as any);
}

test("buildLostEvent produces a valid session.lost envelope", () => {
  const ev = buildLostEvent({ sessionId: "s1", host: "h", now: () => "2026-06-08T00:00:00.000Z", newId: () => "id1" });
  expect(ev).toEqual({ event_id: "id1", ts: "2026-06-08T00:00:00.000Z", session_id: "s1",
    kind: "session.lost", version: 1, host: "h", payload: { reason: "pid_dead" }, dedup_key: null });
});

test("sweepNativeLiveness marks dead pids lost and leaves live ones idle", () => {
  const store = Store.openInMemory();
  nativeRow(store, "alive", 100);   // a freshly registered native row is 'idle'
  nativeRow(store, "dead", 200);
  const lost = sweepNativeLiveness(store, { host: "h", isAlive: (pid) => pid === 100 });
  expect(lost).toBe(1);
  expect(store.getSession("dead")!.status).toBe("lost");
  expect(store.getSession("alive")!.status).toBe("idle");
  store.close();
});

test("sweepNativeLiveness ignores other hosts", () => {
  const store = Store.openInMemory();
  nativeRow(store, "remote", 300, "elsewhere");
  const lost = sweepNativeLiveness(store, { host: "h", isAlive: () => false });
  expect(lost).toBe(0);
  store.close();
});
