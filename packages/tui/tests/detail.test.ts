import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { detailLines } from "../src/detail.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "aaaa", agent_kind: "claude", profile: "main", native_session_id: null,
    command: "claude", args: ["--foo"], env_overrides: {}, cwd: "/tmp", pid: 42,
    tmux_session: "agmux", tmux_window: "@3", tmux_pane: "%9", host: "h", project: "agmux",
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: "2026-06-11T10:05:00.000Z",
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: 4, last_tool: null, last_tool_detail: null, last_input_kind: null, activity_ts: null, ...over,
  };
}

test("detailLines renders core fields and tmux coords", () => {
  const lines = detailLines(mkRow(), null);
  expect(lines).toContain("status   running");
  expect(lines).toContain("agent    claude (main)");
  expect(lines).toContain("project  agmux");
  expect(lines).toContain("command  claude --foo");
  expect(lines).toContain("tmux     agmux:@3.%9");
});

test("detailLines appends usage when present", () => {
  const lines = detailLines(mkRow(), {
    input_tokens: 1200, output_tokens: 800, cost_usd: 0.84, last_model: "sonnet-4-6", turn_count: 4,
  });
  expect(lines).toContain("tokens   in 1200 · out 800");
  expect(lines).toContain("model    sonnet-4-6");
  expect(lines).toContain("cost     $0.84");
});

test("detailLines omits usage block when null", () => {
  expect(detailLines(mkRow(), null).some((l) => l.startsWith("tokens"))).toBe(false);
});
