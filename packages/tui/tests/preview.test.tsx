import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { SessionRow } from "@agmux/protocol";
import { Preview, clampLines, truncateLine, fitBody } from "../src/preview.tsx";

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

test("clampLines clips the top and keeps the newest tail", () => {
  expect(clampLines(["a", "b", "c", "d"], 3)).toEqual(["…", "c", "d"]);
  expect(clampLines(["a", "b", "c"], 1)).toEqual(["…"]);
});

test("truncateLine hard-caps a wide line (used for table rows / tab header)", () => {
  expect(truncateLine("hello", 10)).toBe("hello");
  expect(truncateLine("hello world", 6)).toBe("hello…");
  expect(truncateLine("x".repeat(99), Infinity)).toHaveLength(99); // no width = untouched
});

test("fitBody hard-wraps wide lines (keeps content) and clamps to the newest rows", () => {
  // Short content renders short — NO padding, so the frame stays small while navigating.
  expect(fitBody(["a", "b"], 5, 40)).toEqual(["a", "b"]);
  // A wide line is wrapped into width-sized rows, not truncated — full text preserved.
  expect(fitBody(["abcdefghij"], 9, 4)).toEqual(["abcd", "efgh", "ij"]);
  // When the wrapped rows exceed the budget, keep the newest tail + a top marker.
  expect(fitBody(["abcdefghij"], 2, 4)).toEqual(["…", "ij"]);
  // Infinite budget / width (tests, no viewport) leaves content untouched.
  expect(fitBody(["a"], Infinity, Infinity)).toEqual(["a"]);
});

test("Preview clips a long mirror body to the line budget but keeps the header", () => {
  const body = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
  const { lastFrame } = render(
    <Preview row={mkRow()} mode="mirror" mirrorText={body} events={[]} usage={null} maxBodyLines={5} />,
  );
  const frame = lastFrame()!;
  expect(frame).toContain("[mirror]");      // header stays
  expect(frame).toContain("line49");        // bottom of body kept (newest)
  expect(frame).toContain("…");             // truncation marker
  expect(frame).not.toContain("line0");     // top overflow dropped
});
