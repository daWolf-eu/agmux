import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

const sid = "0190a3e0-0000-7000-8000-000000000001";
const host = "macbook.local";
let seq = 0;
function ev(kind: string, ts: string, payload: unknown) {
  return {
    event_id: `01HZ7P0K8WVQH8WGS8X9DCA${String(seq++).padStart(3, "0")}`,
    ts, session_id: sid, kind, version: 1, host, payload,
  };
}

function startSession(s: Store): void {
  s.append(ev("session.started", "2026-06-11T12:00:00.000Z", {
    agent_kind: "claude", profile: null, command: "claude",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
    tmux_session: null, tmux_window: null, tmux_pane: null, project: null,
  }));
}

interface ActivityRow {
  last_tool: string | null;
  last_tool_detail: string | null;
  last_input_kind: string | null;
  activity_ts: string | null;
}
function activity(s: Store): ActivityRow | null {
  return s.rawDb()
    .query<ActivityRow, [string]>(
      `SELECT last_tool, last_tool_detail, last_input_kind, activity_ts
         FROM session_activity WHERE session_id = ?`,
    )
    .get(sid) ?? null;
}

test("tool.used upserts tool, detail, and activity_ts", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "src/ls.ts" }));
  expect(activity(s)).toEqual({
    last_tool: "Edit", last_tool_detail: "src/ls.ts",
    last_input_kind: null, activity_ts: "2026-06-11T12:00:02.000Z",
  });
  s.append(ev("tool.used", "2026-06-11T12:00:03.000Z", { tool: "Bash" }));
  expect(activity(s)?.last_tool).toBe("Bash");
  expect(activity(s)?.last_tool_detail).toBeNull();
});

test("input.required sets last_input_kind; input.received clears it", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("input.required", "2026-06-11T12:00:01.000Z", { kind: "permission" }));
  expect(activity(s)?.last_input_kind).toBe("permission");
  s.append(ev("input.received", "2026-06-11T12:00:02.000Z", {}));
  expect(activity(s)?.last_input_kind).toBeNull();
});

test("turn.started clears the previous turn's tool (stale tool must not show as current)", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "a.ts" }));
  s.append(ev("turn.ended", "2026-06-11T12:00:03.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:04.000Z", { tool: "Stale", detail: "x" })); // stray between turns
  s.append(ev("turn.started", "2026-06-11T12:00:05.000Z", {}));
  expect(activity(s)?.last_tool).toBeNull();
  expect(activity(s)?.last_tool_detail).toBeNull();
});

test("turn.ended clears tool and input kind", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "a.ts" }));
  s.append(ev("input.required", "2026-06-11T12:00:03.000Z", { kind: "prompt" }));
  s.append(ev("turn.ended", "2026-06-11T12:00:04.000Z", {}));
  const a = activity(s);
  expect(a?.last_tool).toBeNull();
  expect(a?.last_tool_detail).toBeNull();
  expect(a?.last_input_kind).toBeNull();
});

test("ended guard: activity writes after session.ended are inert", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("session.ended", "2026-06-11T12:00:01.000Z", { exit_code: 0, signal: null, reason: "normal" }));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit" }));
  s.append(ev("input.required", "2026-06-11T12:00:03.000Z", { kind: "prompt" }));
  expect(activity(s)).toBeNull();
});

test("unknown session: activity writes are inert (no orphan rows)", () => {
  const s = Store.openInMemory();
  s.append(ev("tool.used", "2026-06-11T12:00:00.000Z", { tool: "Edit" }));
  expect(activity(s)).toBeNull();
});

test("rebuildProjections clears and replays session_activity", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("turn.started", "2026-06-11T12:00:01.000Z", {}));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "a.ts" }));
  s.rebuildProjections();
  expect(activity(s)?.last_tool).toBe("Edit");
});

test("lost guard parity: a lost session is still activity-writable (like applyLiveStatus)", () => {
  const s = Store.openInMemory();
  startSession(s);
  s.append(ev("session.lost", "2026-06-11T12:00:01.000Z", { reason: "pid_dead" }));
  s.append(ev("tool.used", "2026-06-11T12:00:02.000Z", { tool: "Edit", detail: "a.ts" }));
  expect(activity(s)?.last_tool).toBe("Edit");
});
