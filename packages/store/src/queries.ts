import type { Database } from "bun:sqlite";
import type { EventEnvelope, SessionRow, SessionStatus, StatusDecision } from "@agmux/protocol";
import { LIVE_STATUSES } from "@agmux/protocol";
import { deriveStatus } from "./lost.ts";

// Everything decodeRow and deriveStatus need, joined once. `done` vs `idle` is
// derived in JS (deriveStatus) from attention_ts / seen_ts, like `lost`, so the
// status filter below runs after derivation.
const ROW_SELECT = `SELECT s.*, u.turn_count,
       a.last_tool, a.last_tool_detail, a.last_input_kind, a.activity_ts,
       a.attention_ts, a.attention_kind, a.title, a.title_activity, a.title_ts,
       sn.seen_ts, sn.seen_source,
       m.name AS meta_name, m.name_source AS meta_name_source,
       m.git_branch, m.git_repo, m.git_remote, m.git_root
  FROM sessions s
  LEFT JOIN session_usage u ON u.session_id = s.session_id
  LEFT JOIN session_activity a ON a.session_id = s.session_id
  LEFT JOIN session_seen sn ON sn.session_id = s.session_id
  LEFT JOIN session_meta m ON m.session_id = s.session_id`;

// The session's human-readable name: what the agent reported, else the name in
// its terminal title. The title only counts when it parsed as an agent title
// (title_activity set) — a bare title is often just the shell or the cwd.
function displayName(raw: any): { name: string | null; name_source: string | null } {
  if (raw.meta_name) return { name: raw.meta_name, name_source: raw.meta_name_source ?? null };
  if (raw.title && raw.title_activity) return { name: raw.title, name_source: "terminal" };
  return { name: null, name_source: null };
}

function decodeRow(raw: any): SessionRow {
  return {
    session_id: raw.session_id,
    agent_kind: raw.agent_kind,
    profile: raw.profile,
    native_session_id: raw.native_session_id,
    command: raw.command,
    args: JSON.parse(raw.args_json),
    env_overrides: JSON.parse(raw.env_json),
    cwd: raw.cwd,
    pid: raw.pid,
    tmux_session: raw.tmux_session,
    tmux_window: raw.tmux_window,
    tmux_pane: raw.tmux_pane,
    tmux_socket: raw.tmux_socket ?? null,
    host: raw.host,
    project: raw.project,
    parent_session_id: raw.parent_session_id,
    start_ts: raw.start_ts,
    last_heartbeat_ts: raw.last_heartbeat_ts,
    end_ts: raw.end_ts,
    exit_code: raw.exit_code,
    signal: raw.signal,
    status: raw.status as SessionStatus,
    origin: (raw.origin ?? "wrapper") as SessionRow["origin"],
    turn_count: raw.turn_count ?? null,
    last_tool: raw.last_tool ?? null,
    last_tool_detail: raw.last_tool_detail ?? null,
    last_input_kind: raw.last_input_kind ?? null,
    activity_ts: raw.activity_ts ?? null,
    attention_ts: raw.attention_ts ?? null,
    status_kind: raw.status_kind ?? null,
    status_ts: raw.status_ts ?? null,
    attention_kind: raw.attention_kind ?? null,
    seen_ts: raw.seen_ts ?? null,
    seen_source: raw.seen_source ?? null,
    title: raw.title ?? null,
    title_activity: raw.title_activity ?? null,
    title_ts: raw.title_ts ?? null,
    ...displayName(raw),
    git_branch: raw.git_branch ?? null,
    git_repo: raw.git_repo ?? null,
    git_remote: raw.git_remote ?? null,
    git_root: raw.git_root ?? null,
  };
}

function storedRow(db: Database, sid: string): SessionRow | null {
  const raw = db.query<any, [string]>(`${ROW_SELECT} WHERE s.session_id = ?`).get(sid);
  return raw ? decodeRow(raw) : null;
}

export function getSessionRaw(db: Database, sid: string, now: Date): SessionRow | null {
  const r = storedRow(db, sid);
  if (!r) return null;
  r.status = deriveStatus(r, now).status;
  return r;
}

// `agmux explain`: the derived status plus every input that produced it.
export function explainSession(db: Database, sid: string, now: Date): StatusDecision | null {
  const r = storedRow(db, sid);
  if (!r) return null;
  const d = deriveStatus(r, now);
  return {
    session_id: r.session_id,
    status: d.status,
    stored_status: r.status,
    rule: d.rule,
    reason: d.reason,
    status_event: { kind: r.status_kind ?? null, ts: r.status_ts ?? null },
    attention: { kind: r.attention_kind ?? null, ts: r.attention_ts ?? null },
    seen: { source: r.seen_source ?? null, ts: r.seen_ts ?? null },
    title: { title: r.title ?? null, activity: r.title_activity ?? null, ts: r.title_ts ?? null },
    meta: {
      name: r.name ?? null, name_source: r.name_source ?? null,
      git_repo: r.git_repo ?? null, git_branch: r.git_branch ?? null, git_root: r.git_root ?? null,
    },
    last_input_kind: r.last_input_kind ?? null,
    last_tool: r.last_tool ?? null,
    last_work_ts: d.last_work_ts,
    now: now.toISOString(),
  };
}

export interface ListSessionsOpts {
  live?: boolean;                       // alias for statuses=LIVE_STATUSES
  statuses?: readonly SessionStatus[];  // post-computation filter; wins over `live`
  agent_kind?: string;
  profile?: string;
  since?: string;
  limit?: number;
  sort?: "started" | "activity";
  order?: "asc" | "desc";
  now?: Date;
}

export function listSessions(db: Database, opts: ListSessionsOpts): SessionRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.agent_kind) { where.push("agent_kind = ?"); params.push(opts.agent_kind); }
  if (opts.profile)    { where.push("profile = ?");    params.push(opts.profile); }
  if (opts.since)      { where.push("start_ts >= ?");  params.push(opts.since); }

  // Whitelist-mapped ORDER BY — caller input never reaches the SQL string.
  const sortCol = opts.sort === "activity" ? "COALESCE(s.last_heartbeat_ts, s.start_ts)" : "s.start_ts";
  const dir = opts.order === "asc" ? "ASC" : "DESC";

  // Status is computed in JS (lost = heartbeat staleness), so with a status
  // filter the row cap must apply AFTER filtering — a SQL LIMIT would starve
  // the result when newer rows fail the filter.
  const statuses = opts.statuses ?? (opts.live ? LIVE_STATUSES : undefined);
  const limit = opts.limit ?? 200;

  const sql = `${ROW_SELECT}
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY ${sortCol} ${dir}
               ${statuses ? "" : "LIMIT ?"}`;
  if (!statuses) params.push(limit);
  const raws = db.query<any, any[]>(sql).all(...(params as any[]));
  const now = opts.now ?? new Date();
  let rows = raws.map(decodeRow).map((r) => {
    r.status = deriveStatus(r, now).status;
    return r;
  });
  if (statuses) rows = rows.filter((r) => statuses.includes(r.status)).slice(0, limit);
  return rows;
}

export interface ListEventsOpts {
  session_id?: string;
  kind?: string;
  since?: string;
  limit?: number;
}

export function listEvents(db: Database, opts: ListEventsOpts): EventEnvelope[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.session_id) { where.push("session_id = ?"); params.push(opts.session_id); }
  if (opts.kind)       { where.push("kind = ?");       params.push(opts.kind); }
  if (opts.since)      { where.push("ts >= ?");        params.push(opts.since); }
  const sql = `SELECT event_id, ts, session_id, kind, version, payload, host
               FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY id ASC
               LIMIT ?`;
  params.push(opts.limit ?? 1000);
  return db.query<any, any[]>(sql).all(...(params as any[])).map((r) => ({
    event_id: r.event_id,
    ts: r.ts,
    session_id: r.session_id,
    kind: r.kind,
    version: r.version,
    host: r.host,
    payload: JSON.parse(r.payload),
  }));
}

export interface SessionUsageRow {
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  last_model: string | null;
  last_rate_limit: unknown;     // decoded from JSON
  turn_count: number;
}

export function getSessionUsage(db: Database, sid: string): SessionUsageRow | null {
  const raw = db.query<any, [string]>(`SELECT * FROM session_usage WHERE session_id = ?`).get(sid);
  if (!raw) return null;
  return {
    session_id: raw.session_id,
    input_tokens: raw.input_tokens,
    output_tokens: raw.output_tokens,
    reasoning_output_tokens: raw.reasoning_output_tokens,
    cache_read_tokens: raw.cache_read_tokens,
    cache_write_tokens: raw.cache_write_tokens,
    cost_usd: raw.cost_usd,
    last_model: raw.last_model,
    last_rate_limit: raw.last_rate_limit == null ? null : JSON.parse(raw.last_rate_limit),
    turn_count: raw.turn_count,
  };
}

// pid-sweep candidates (spec §3): live native rows on a given host that carry a
// pid. Cross-host native rows are intentionally excluded (never pid-swept).
export function listLiveNativeSessions(db: Database, host: string): { session_id: string; pid: number }[] {
  return db.query<{ session_id: string; pid: number }, [string]>(
    `SELECT session_id, pid FROM sessions
       WHERE origin = 'native' AND pid IS NOT NULL AND host = ?
         AND status IN ('idle', 'running', 'waiting')`,
  ).all(host);
}
