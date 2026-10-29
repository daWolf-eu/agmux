import { test, expect } from "bun:test";
import type { SessionRow, SessionStatus } from "@agmux/protocol";
import { activityCell, formatTable } from "../src/format.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    tmux_server: null,
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

test("formatTable shows NAME, REPO and BRANCH; long names and branches are clipped", () => {
  const lines = formatTable([mkRow({ name: "n".repeat(40), git_repo: "agmux", git_branch: "feature/" + "b".repeat(30) })], false);
  const header = lines[0]!.split(/\s{2,}/);
  expect(header.indexOf("NAME")).toBe(1);
  expect(header.indexOf("BRANCH")).toBe(header.indexOf("REPO") + 1);
  const cells = lines[1]!.split(/\s{2,}/);
  expect(cells[1]).toBe("n".repeat(31) + "…");
  expect(cells[header.indexOf("REPO")]).toBe("agmux");
  expect(cells[header.indexOf("BRANCH")]!.length).toBe(24);
});

test("formatTable renders '-' for sessions without metadata", () => {
  const cells = formatTable([mkRow()], false)[1]!.split(/\s{2,}/);
  expect(cells[1]).toBe("-");
});

test("formatTable without remote rows is byte-identical to the pre-HOST layout", () => {
  const rows = [mkRow({ session_id: "aaaa", name: "fix", git_repo: "agmux", git_branch: "main", last_tool: "Edit", last_tool_detail: "x.ts", tmux_session: "w", tmux_window: "1" })];
  expect(formatTable(rows, false)).toEqual([
    "ID    NAME  AGENT   PROFILE  STATUS   TURNS  ACTIVITY         REPO   BRANCH  PID  TMUX  START        LAST_SEEN  ",
    "aaaa  fix   claude  -        running  -      tool: Edit x.ts  agmux  main    1    w:1   06-11 10:00  06-11 10:00",
  ]);
});

test("formatTable with a remote row: HOST right after NAME; local cell is exactly '-'", () => {
  const lines = formatTable([mkRow({ session_id: "l", name: "loc" }), mkRow({ session_id: "r", name: "rem", remote: true, host: "os/sbx-1" })], false);
  const col = lines[0]!.indexOf("HOST");
  expect(lines[0]!.indexOf("NAME")).toBeLessThan(col);
  expect(lines[0]!.slice(0, col).trim().split(/\s+/)).toEqual(["ID", "NAME"]);
  const hostCell = (l: string) => l.slice(col, col + "HOST".length).trimEnd();
  expect(hostCell(lines[1]!)).toBe("-");
  expect(lines[2]!.slice(col)).toStartWith("⇄ sbx-1");
});

test("formatTable replaces control characters in every cell: one line per row, no escapes", () => {
  const evil = "x\x1b]52;c;ZXZpbA==\x07\ny";
  const lines = formatTable([mkRow({ name: evil, git_repo: evil, git_branch: evil, cwd: evil, last_tool: evil, last_tool_detail: evil, profile: evil })], false);
  expect(lines).toHaveLength(2);
  for (const l of lines) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  expect(lines[1]).toContain("x ]52;c;ZXZpbA==  y");
});
