import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { buildCapturePaneArgs, makePreviewSource } from "../src/dash-preview.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "s1", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: "agmux", tmux_window: "@1", tmux_pane: "%1", tmux_socket: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null, activity_ts: null, ...over,
  };
}

test("buildCapturePaneArgs targets the pane in print mode", () => {
  expect(buildCapturePaneArgs("%9")).toEqual(["capture-pane", "-p", "-t", "%9"]);
});

test("mirror returns '' for a dead or pane-less session (no tmux call)", async () => {
  let called = false;
  const src = makePreviewSource("http://h", async () => { called = true; return "x"; });
  expect(await src.mirror(mkRow({ status: "ended", tmux_pane: null }))).toBe("");
  expect(called).toBe(false);
});

test("mirror runs capture-pane for a live session", async () => {
  const src = makePreviewSource("http://h", async (args) => `ran ${args.join(" ")}`);
  expect(await src.mirror(mkRow())).toBe("ran capture-pane -p -t %1");
});

test("buildCapturePaneArgs prepends -S <socket> when given", () => {
  expect(buildCapturePaneArgs("%9", "/tmp/sock")).toEqual(["-S", "/tmp/sock", "capture-pane", "-p", "-t", "%9"]);
});

test("mirror targets the session's server when tmux_socket is set", async () => {
  const src = makePreviewSource("http://h", async (args) => `ran ${args.join(" ")}`);
  expect(await src.mirror(mkRow({ tmux_socket: "/tmp/sock" }))).toBe("ran -S /tmp/sock capture-pane -p -t %1");
});

test("usage maps the hub usage row, null when absent", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    session: mkRow(), events: [],
    usage: { session_id: "s1", input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.5, last_model: "m", last_rate_limit: null, turn_count: 3 },
  }), { status: 200 })) as unknown as typeof fetch;
  try {
    const src = makePreviewSource("http://h");
    expect(await src.usage(mkRow())).toEqual({ input_tokens: 10, output_tokens: 5, cost_usd: 0.5, last_model: "m", turn_count: 3 });
  } finally { globalThis.fetch = orig; }
});
