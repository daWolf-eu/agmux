export const SESSION_STATUSES = ["idle", "running", "waiting", "ended", "lost"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const LIVE_STATUSES: readonly SessionStatus[] = ["idle", "running", "waiting"];
export const TERMINAL_STATUSES: readonly SessionStatus[] = ["ended", "lost"];

// Single source of truth for known agent kinds. Adding a kind here flows to the
// AgentKind type AND the runtime ingest validators (validators.ts) — keeps new
// providers from being silently rejected at the hub boundary.
export const AGENT_KINDS = ["claude", "codex", "pi"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

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
  // tmux server socket path (null = ambient/default server)
  tmux_socket: string | null;
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
  // Joined from the session_activity projection (null/absent = nothing
  // observed). last_tool/_detail are only meaningful while status=running;
  // last_input_kind ("prompt" | "permission" | "confirm") while status=waiting.
  last_tool?: string | null;
  last_tool_detail?: string | null;
  last_input_kind?: string | null;
  activity_ts?: string | null;
}

// `agmux ls --status` vocabulary: group aliases over the raw statuses.
export const STATUS_GROUPS: Record<string, readonly SessionStatus[]> = {
  active: ["running", "waiting"],
  open: LIVE_STATUSES,
  closed: TERMINAL_STATUSES,
};

// "active" | "open" | "closed" | comma-separated raw statuses → status list.
// Returns null for anything else (caller decides how to error).
export function expandStatusFilter(value: string): SessionStatus[] | null {
  const group = STATUS_GROUPS[value];
  if (group) return [...group];
  const parts = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const out: SessionStatus[] = [];
  for (const p of parts) {
    if (!(SESSION_STATUSES as readonly string[]).includes(p)) return null;
    out.push(p as SessionStatus);
  }
  return out;
}
