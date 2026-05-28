export const SESSION_STATUSES = ["idle", "running", "waiting", "ended", "lost"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const LIVE_STATUSES: readonly SessionStatus[] = ["idle", "running", "waiting"];
export const TERMINAL_STATUSES: readonly SessionStatus[] = ["ended", "lost"];

export type AgentKind = "claude" | "codex";

export interface SessionRow {
  session_id: string;
  agent_kind: AgentKind;
  profile: string | null;
  native_session_id: string | null;
  command: string;
  args: string[];
  env_overrides: Record<string, string>;
  cwd: string;
  pid: number | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  host: string;
  project: string | null;
  parent_session_id: string | null;
  start_ts: string;
  last_heartbeat_ts: string | null;
  end_ts: string | null;
  exit_code: number | null;
  signal: string | null;
  status: SessionStatus;
}
