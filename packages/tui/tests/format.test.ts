import { test, expect } from "bun:test";
import type { SessionRow, SessionStatus } from "@agmux/protocol";
import { activityCell, formatTable } from "../src/format.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "aaaa", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_socket: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null,
    activity_ts: null, ...over,
  };
}

test("running with tool renders tool and detail", () => {
  expect(activityCell(mkRow({ last_tool: "Edit", last_tool_detail: "src/ls.ts" })))
    .toBe("tool: Edit src/ls.ts");
});

test("running without tool renders 'working'", () => {
  expect(activityCell(mkRow())).toBe("working");
});

test("waiting renders the input kind, with a generic fallback", () => {
  expect(activityCell(mkRow({ status: "waiting", last_input_kind: "permission" })))
    .toBe("input: permission");
  expect(activityCell(mkRow({ status: "waiting" }))).toBe("input: input");
});

test("idle/ended/lost render '-' even with stale fields", () => {
  for (const status of ["idle", "ended", "lost"] as SessionStatus[]) {
    expect(activityCell(mkRow({ status, last_tool: "Edit" }))).toBe("-");
  }
});

test("cell is capped at 40 chars with ellipsis", () => {
  const cell = activityCell(mkRow({ last_tool: "Bash", last_tool_detail: "x".repeat(60) }));
  expect(cell.length).toBe(40);
  expect(cell.endsWith("…")).toBe(true);
  expect(cell.startsWith("tool: Bash")).toBe(true);
});

test("formatTable includes the ACTIVITY column after TURNS", () => {
  const lines = formatTable([mkRow({ last_tool: "Edit" })], false);
  const header = lines[0]!.split(/\s{2,}/);
  expect(header.indexOf("ACTIVITY")).toBe(header.indexOf("TURNS") + 1);
  expect(lines[1]).toContain("tool: Edit");
});

test("formatTable: reverse flips data rows but keeps the header on top", () => {
  const rows = [
    mkRow({ session_id: "aaaa", start_ts: "2026-06-10T11:00:00.000Z" }),
    mkRow({ session_id: "bbbb", start_ts: "2026-06-10T10:00:00.000Z" }),
  ];
  const flipped = formatTable(rows, true);
  expect(flipped[0]).toStartWith("ID");
  expect(flipped[1]).toStartWith("bbbb");
  expect(flipped[2]).toStartWith("aaaa");
});
