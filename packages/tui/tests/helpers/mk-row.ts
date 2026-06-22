import type { SessionRow } from "@agmux/protocol";

export function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "agx-000000001", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-20T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null,
    activity_ts: null, ...over,
  };
}
