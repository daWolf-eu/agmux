import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { SessionRow } from "@agmux/protocol";
import { Preview, clampLines } from "../src/preview.tsx";

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

test("clampLines keeps everything when within budget", () => {
  expect(clampLines(["a", "b", "c"], 5)).toEqual(["a", "b", "c"]);
  expect(clampLines(["a", "b"], Infinity)).toEqual(["a", "b"]);
});

test("clampLines collapses overflow into a trailing ellipsis", () => {
  expect(clampLines(["a", "b", "c", "d"], 3)).toEqual(["a", "b", "…"]);
  expect(clampLines(["a", "b", "c"], 1)).toEqual(["…"]);
});

test("Preview clips a long mirror body to the line budget but keeps the header", () => {
  const body = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
  const { lastFrame } = render(
    <Preview row={mkRow()} mode="mirror" mirrorText={body} events={[]} usage={null} maxBodyLines={5} />,
  );
  const frame = lastFrame()!;
  expect(frame).toContain("[mirror]");      // header stays
  expect(frame).toContain("line0");         // top of body kept
  expect(frame).toContain("…");             // truncation marker
  expect(frame).not.toContain("line49");    // overflow dropped
});
