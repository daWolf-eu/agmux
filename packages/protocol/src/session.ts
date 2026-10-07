// Read-ness is part of the status vocabulary, not a separate axis:
//   done  = the turn finished and you have not looked at it since
//   idle  = finished/quiet and seen (or nothing has happened yet)
// `done` is never stored: the projection keeps `idle` plus the attention/seen
// timestamps, and the query layer derives `done` from them (like `lost`). A
// `waiting` session needs action, not reading, so it has no seen/unseen split.
export const SESSION_STATUSES = ["idle", "done", "running", "waiting", "ended", "lost"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const LIVE_STATUSES: readonly SessionStatus[] = ["idle", "done", "running", "waiting"];
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
  // Joined from the session_activity projection. Moves ONLY on attention-worthy
  // events (input.required / turn.ended / session.ended) — never on tool.used,
  // unlike activity_ts. This is the identity of an "attention episode": the unit
  // both the unread flag and the notification debounce are keyed on, so that a
  // busy session cannot manufacture new episodes by running tools.
  attention_ts?: string | null;
  // Provenance (`agmux explain`): which event last set the STORED status, and
  // which event last moved attention_ts. `status` itself is the derived value.
  status_kind?: string | null;
  status_ts?: string | null;
  attention_kind?: string | null;
  // Joined from the session_seen projection: the last acknowledgement and what
  // caused it (attach | dismiss | focus | prompt | input).
  seen_ts?: string | null;
  seen_source?: string | null;
  // Joined from the session_activity projection: the agent's last terminal
  // title, with the status glyph stripped, and what it said about activity.
  title?: string | null;
  title_activity?: string | null;
  title_ts?: string | null;
  // Joined from the session_meta projection (session.metadata). `name` is the
  // human-readable session name; when the agent never reported one it falls
  // back, at read time, to the terminal-title name (name_source "terminal").
  name?: string | null;
  name_source?: string | null;
  git_branch?: string | null;
  git_repo?: string | null;
  git_remote?: string | null;
  git_root?: string | null;
}

// `agmux ls --status` vocabulary: group aliases over the raw statuses.
export const STATUS_GROUPS: Record<string, readonly SessionStatus[]> = {
  active: ["running", "waiting"],
  // Wants you: blocked on input, or finished and not yet seen.
  attention: ["waiting", "done"],
  open: LIVE_STATUSES,
  closed: TERMINAL_STATUSES,
};

// "active" | "attention" | "open" | "closed" | comma-separated raw statuses → status list.
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

// Why a session shows the status it does (`agmux explain`). Built by the same
// function that derives `status` for every query, so the two cannot disagree.
export type StatusRule =
  | "terminal"          // stored ended/lost, reported as-is
  | "heartbeat-stale"   // wrapper row with no heartbeat for LOST_THRESHOLD_MS → lost
  | "working-timeout"   // running with no evidence of work for WORKING_TIMEOUT_MS → idle
  | "unseen"            // idle, but the last attention event is newer than the last seen → done
  | "stored";           // the projection's status, unchanged

export interface StatusDecision {
  session_id: string;
  status: SessionStatus;
  stored_status: SessionStatus;
  rule: StatusRule;
  reason: string;
  status_event: { kind: string | null; ts: string | null };
  attention: { kind: string | null; ts: string | null };
  seen: { source: string | null; ts: string | null };
  title: { title: string | null; activity: string | null; ts: string | null };
  meta: { name: string | null; name_source: string | null; git_repo: string | null; git_branch: string | null; git_root: string | null };
  last_input_kind: string | null;
  last_tool: string | null;
  // Newest evidence the agent was working (input to the working timeout).
  last_work_ts: string | null;
  now: string;
}
