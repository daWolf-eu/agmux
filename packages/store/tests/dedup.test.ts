import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

const sid = "0190a3e0-0000-7000-8000-000000000000";

function startedEvent() {
  return {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
    ts: "2026-05-28T12:00:00.000Z",
    session_id: sid, kind: "session.started", version: 1, host: "h",
    payload: {
      agent_kind: "codex", profile: null, command: "codex", args: [],
      env_overrides: {}, cwd: "/tmp", pid: 1, tmux_session: null,
      tmux_window: null, tmux_pane: null, project: null,
    },
  } as any;
}

function usageEvent(eventId: string, dedupKey: string | null) {
  return {
    event_id: eventId,
    ts: "2026-05-28T12:01:00.000Z",
    session_id: sid, kind: "usage.reported", version: 1, host: "h",
    dedup_key: dedupKey,
    payload: { cumulative: false, source: "transcript-delta", input_tokens: 100 },
  } as any;
}

test("append skips a second event with the same dedup_key", () => {
  const store = Store.openInMemory();
  store.append(startedEvent());
  expect(store.append(usageEvent("01HZ7P0K8WVQH8WGS8X9DC9001", "codex:t:42"))).toBe(true);
  expect(store.append(usageEvent("01HZ7P0K8WVQH8WGS8X9DC9002", "codex:t:42"))).toBe(false);
  const usage = store.getSessionUsage(sid);
  expect(usage!.input_tokens).toBe(100); // applied once, not twice
  store.close();
});

test("append allows multiple events with null dedup_key", () => {
  const store = Store.openInMemory();
  store.append(startedEvent());
  expect(store.append(usageEvent("01HZ7P0K8WVQH8WGS8X9DC9003", null))).toBe(true);
  expect(store.append(usageEvent("01HZ7P0K8WVQH8WGS8X9DC9004", null))).toBe(true);
  const usage = store.getSessionUsage(sid);
  expect(usage!.input_tokens).toBe(200); // both applied
  store.close();
});
