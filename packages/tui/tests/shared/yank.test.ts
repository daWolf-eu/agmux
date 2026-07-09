import { test, expect } from "bun:test";
import { yankFields, tmuxTarget } from "../../src/shared/yank.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("yankFields returns 10 fields in fixed label order", () => {
  const fields = yankFields(mkRow());
  expect(fields.map((f) => f.label)).toEqual([
    "Session ID", "Native ID", "CWD", "Command", "Project",
    "TMUX", "PID", "Host", "Profile", "Parent ID",
  ]);
});

test("yankFields formats values from a fully-populated row", () => {
  const row = mkRow({
    session_id: "agx-abc", native_session_id: "nat-1", cwd: "/work/proj",
    command: "claude", args: ["--resume", "x"], project: "proj",
    tmux_session: "main", tmux_window: "w1", tmux_pane: "%3",
    pid: 4242, host: "mac", profile: "default", parent_session_id: "agx-parent",
  });
  const by = Object.fromEntries(yankFields(row).map((f) => [f.label, f.value])) as Record<string, string>;
  expect(by["Session ID"]).toBe("agx-abc");
  expect(by["Native ID"]).toBe("nat-1");
  expect(by["CWD"]).toBe("/work/proj");
  expect(by["Command"]).toBe("claude --resume x");
  expect(by["Project"]).toBe("proj");
  expect(by["TMUX"]).toBe("main:w1 %3");
  expect(by["PID"]).toBe("4242");
  expect(by["Host"]).toBe("mac");
  expect(by["Profile"]).toBe("default");
  expect(by["Parent ID"]).toBe("agx-parent");
  expect(yankFields(row).every((f) => f.empty === false)).toBe(true);
});

test("yankFields marks nullable columns empty on a sparse row", () => {
  // mkRow defaults: native_session_id/project/profile/parent_session_id = null,
  // tmux_* = null. pid defaults to 1, so PID is NOT empty here.
  const fields = Object.fromEntries(yankFields(mkRow()).map((f) => [f.label, f])) as Record<string, { empty: boolean; value: string }>;
  for (const label of ["Native ID", "Project", "TMUX", "Profile", "Parent ID"]) {
    expect(fields[label]!.empty).toBe(true);
    expect(fields[label]!.value).toBe("");
  }
  expect(fields["Session ID"]!.empty).toBe(false);
});

test("PID is empty when pid is null", () => {
  const pid = Object.fromEntries(yankFields(mkRow({ pid: null })).map((f) => [f.label, f])) as Record<string, { empty: boolean; value: string }>;
  expect(pid["PID"]!.empty).toBe(true);
  expect(pid["PID"]!.value).toBe("");
});

test("tmuxTarget is empty without a session and joins when present", () => {
  expect(tmuxTarget(mkRow())).toBe("");
  expect(tmuxTarget(mkRow({ tmux_session: "s", tmux_window: "w" }))).toBe("s:w");
  expect(tmuxTarget(mkRow({ tmux_session: "s", tmux_window: "w", tmux_pane: "%2" }))).toBe("s:w %2");
});
