import { test, expect } from "bun:test";
import type { SessionRow, SessionStatus } from "@agmux/protocol";
import {
  groupSessions, buildDashTable, selectableRows, matchesFilter, dashActivityCell, dashTmuxCell, DASH_HEADER,
} from "../src/group-table.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "aaaaaaaa-1", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null,
    activity_ts: null, ...over,
  };
}

test("groups appear in fixed order, empty groups dropped", () => {
  const rows = [
    mkRow({ session_id: "idle1", status: "idle" }),
    mkRow({ session_id: "wait1", status: "waiting" }),
    mkRow({ session_id: "run1", status: "running" }),
  ];
  expect(groupSessions(rows).map((g) => g.key)).toEqual(["waiting", "running", "idle"]);
});

test("dashActivityCell shows exit info for closed rows", () => {
  expect(dashActivityCell(mkRow({ status: "ended", exit_code: 0 }))).toBe("exited 0");
  expect(dashActivityCell(mkRow({ status: "ended", signal: "SIGTERM", exit_code: null }))).toBe("signal SIGTERM");
  expect(dashActivityCell(mkRow({ status: "lost" }))).toBe("lost");
  expect(dashActivityCell(mkRow({ status: "running", last_tool: "Edit" }))).toBe("tool: Edit");
});

test("dashTmuxCell joins session:window, dashes when missing, truncates at 24", () => {
  expect(dashTmuxCell(mkRow({ tmux_session: "agmux", tmux_window: "@1" }))).toBe("agmux:@1");
  expect(dashTmuxCell(mkRow({ tmux_session: null, tmux_window: "@1" }))).toBe("-");
  expect(dashTmuxCell(mkRow({ tmux_session: "agmux", tmux_window: null }))).toBe("-");
  const long = dashTmuxCell(mkRow({ tmux_session: "very-long-session-name-here", tmux_window: "@99" }));
  expect(long.length).toBe(24);
  expect(long.endsWith("…")).toBe(true);
});

test("buildDashTable includes the TMUX column", () => {
  const t = buildDashTable([mkRow({ session_id: "run1", status: "running", tmux_session: "mysess", tmux_window: "@2" })]);
  expect(t.header.split(/\s{2,}/)).toContain("TMUX");
  expect(t.groups[0]!.rows[0]!.text).toContain("mysess:@2");
});

test("matchesFilter matches the tmux name", () => {
  expect(matchesFilter(mkRow({ tmux_session: "infra-box", tmux_window: "@1" }), "infra-box")).toBe(true);
});

test("buildDashTable aligns columns across all groups and labels each group", () => {
  const t = buildDashTable([
    mkRow({ session_id: "wait1", status: "waiting", last_input_kind: "permission" }),
    mkRow({ session_id: "run1", status: "running", last_tool: "Edit" }),
  ]);
  expect(t.header.startsWith("ID")).toBe(true);
  expect(t.groups[0]!.label).toBe("NEEDS INPUT");
  expect(t.groups[0]!.count).toBe(1);
  // every row line is the same width as the header (column alignment)
  for (const g of t.groups) for (const r of g.rows) expect(r.text.length).toBe(t.header.length);
});

test("buildDashTable on empty rows yields header from labels only", () => {
  const t = buildDashTable([]);
  expect(t.groups).toEqual([]);
  expect(t.header.split(/\s{2,}/)).toEqual([...DASH_HEADER]);
});

test("selectableRows is the flat ordered row list (no headers)", () => {
  const rows = [mkRow({ session_id: "a", status: "idle" }), mkRow({ session_id: "b", status: "waiting" })];
  expect(selectableRows(rows).map((r) => r.session_id)).toEqual(["b", "a"]);
});

test("matchesFilter matches id/agent/profile/activity case-insensitively", () => {
  const r = mkRow({ session_id: "deadbeef", profile: "infra", status: "running", last_tool: "Bash" });
  expect(matchesFilter(r, "DEAD")).toBe(true);
  expect(matchesFilter(r, "infra")).toBe(true);
  expect(matchesFilter(r, "bash")).toBe(true);
  expect(matchesFilter(r, "codex")).toBe(false);
  expect(matchesFilter(r, "")).toBe(true);
});
