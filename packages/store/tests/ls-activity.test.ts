import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

const sid = "0190a3e0-0000-7000-8000-000000000002";
const host = "macbook.local";
let seq = 0;
function ev(kind: string, ts: string, payload: unknown) {
  return {
    event_id: `01HZ7P0K8WVQH8WGS8X9DCB${String(seq++).padStart(3, "0")}`,
    ts, session_id: sid, kind, version: 1, host, payload,
  };
}

function seeded(): Store {
  const s = Store.openInMemory();
  s.append(ev("session.started", "2026-06-11T12:00:00.000Z", {
    agent_kind: "claude", profile: null, command: "claude",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
    tmux_session: null, tmux_window: null, tmux_pane: null, project: null,
  }));
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "src/ls.ts" }));
  return s;
}

test("listSessions joins activity fields", () => {
  const s = seeded();
  const now = new Date("2026-06-11T12:00:03.000Z");
  const row = s.listSessions({ now }).find((r) => r.session_id === sid)!;
  expect(row.last_tool).toBe("Edit");
  expect(row.last_tool_detail).toBe("src/ls.ts");
  expect(row.last_input_kind).toBeNull();
  expect(row.activity_ts).toBe("2026-06-11T12:00:02.000Z");
});

test("listSessions: no activity row decodes to nulls", () => {
  const s = Store.openInMemory();
  s.append(ev("session.started", "2026-06-11T12:00:00.000Z", {
    agent_kind: "claude", profile: null, command: "claude",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
    tmux_session: null, tmux_window: null, tmux_pane: null, project: null,
  }));
  const row = s.listSessions({ now: new Date("2026-06-11T12:00:01.000Z") })[0]!;
  expect(row.last_tool).toBeNull();
  expect(row.last_input_kind).toBeNull();
  expect(row.activity_ts).toBeNull();
});

test("getSession joins activity fields", () => {
  const s = seeded();
  const row = s.getSession(sid, new Date("2026-06-11T12:00:03.000Z"))!;
  expect(row.last_tool).toBe("Edit");
  expect(row.last_tool_detail).toBe("src/ls.ts");
});
