import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "../src/feed.ts";
import type { Actions, Handoff, PreviewSource } from "../src/types.ts";
import { ManageApp } from "../src/manage-app.tsx";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "aaaaaaaa", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: "agmux", tmux_window: "@1", tmux_pane: "%1", host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: 1, last_tool: "Edit", last_tool_detail: null, last_input_kind: null, activity_ts: null, ...over,
  };
}

function manualFeed() {
  let update: (rows: SessionRow[]) => void = () => {};
  const feed: SessionFeed = { subscribe(onUpdate) { update = onUpdate; return () => {}; } };
  return { feed, push: (r: SessionRow[]) => update(r) };
}

const noopSource: PreviewSource = {
  async mirror() { return "PANE OUTPUT"; },
  async events() { return []; },
  async usage() { return null; },
};
function recordingActions() {
  const calls: string[] = [];
  const actions: Actions = {
    async attach(r) { calls.push(`attach:${r.session_id}`); return null; },
    async kill(r) { calls.push(`kill:${r.session_id}`); },
    async resume(r): Promise<Handoff> { calls.push(`resume:${r.session_id}`); return { argv: ["x"] }; },
  };
  return { actions, calls };
}

const base = {
  source: noopSource, hubUrl: "http://h", defaultPreview: "detail" as const, intervalMs: 100000,
  onHandoff: () => {},
  setIntervalImpl: (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval,
  clearIntervalImpl: (() => {}) as typeof clearInterval,
};

test("renders grouped table with group headers and selects first row", async () => {
  const m = manualFeed();
  const { actions } = recordingActions();
  const { lastFrame } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "run1", status: "running" }), mkRow({ session_id: "wait1", status: "waiting", last_input_kind: "permission" })]);
  await Bun.sleep(0);
  expect(lastFrame()).toContain("NEEDS INPUT (1)");
  expect(lastFrame()).toContain("WORKING (1)");
  expect(lastFrame()).toContain("› wait1");   // first selectable row (waiting group first)
});

test("j moves selection down across groups", async () => {
  const m = manualFeed();
  const { actions } = recordingActions();
  const { lastFrame, stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "wait1", status: "waiting" }), mkRow({ session_id: "run1", status: "running" })]);
  await Bun.sleep(0);
  stdin.write("j");
  await Bun.sleep(0);
  expect(lastFrame()).toContain("› run1");
});

test("tab cycles preview mode label", async () => {
  const m = manualFeed();
  const { actions } = recordingActions();
  const { lastFrame, stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "run1", status: "running" })]);
  await Bun.sleep(0);
  expect(lastFrame()).toContain("[detail]");
  stdin.write("\t");
  await Bun.sleep(0);
  expect(lastFrame()).toContain("[mirror]");
});

test("enter triggers attach", async () => {
  const m = manualFeed();
  const { actions, calls } = recordingActions();
  const { stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "run1", status: "running" })]);
  await Bun.sleep(0);
  stdin.write("\r");
  await Bun.sleep(0);
  expect(calls).toContain("attach:run1");
});

test("x prompts confirm, y kills", async () => {
  const m = manualFeed();
  const { actions, calls } = recordingActions();
  const { lastFrame, stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "run1", status: "running" })]);
  await Bun.sleep(0);
  stdin.write("x");
  await Bun.sleep(0);
  expect(lastFrame()).toContain("kill run1");
  stdin.write("y");
  await Bun.sleep(0);
  expect(calls).toContain("kill:run1");
});

test("mirror mode falls back to events for a dead session", async () => {
  const m = manualFeed();
  const { actions } = recordingActions();
  const { lastFrame, stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "dead1", status: "ended", exit_code: 0, tmux_pane: null })]);
  await Bun.sleep(0);
  stdin.write("\t"); // detail → mirror
  await Bun.sleep(0);
  expect(lastFrame()).toContain("[events]"); // resolved away from mirror
});
