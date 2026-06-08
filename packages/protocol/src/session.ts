export const SESSION_STATUSES = ["idle", "running", "waiting", "ended", "lost"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const LIVE_STATUSES: readonly SessionStatus[] = ["idle", "running", "waiting"];
export const TERMINAL_STATUSES: readonly SessionStatus[] = ["ended", "lost"];

export type AgentKind = "claude" | "codex";

export type SessionOrigin = "wrapper" | "native";

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
  // How the session row was created: "wrapper" = PTY-wrapper-minted (heartbeat
  // liveness); "native" = self-registered from the agent's own hooks (pid-sweep
  // liveness). Drives origin-aware status computation. Defaults to "wrapper" for
  // rows that predate the native-first migration.
  origin: SessionOrigin;
  // Joined from the session_usage projection (null = no usage row yet, i.e. the
  // adapter never observed a turn). Lets consumers tell a real conversation from
  // an empty session without a second query.
  turn_count?: number | null;
}
