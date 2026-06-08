import type { Database } from "bun:sqlite";
import type { EventEnvelope, SessionRow, SessionStatus } from "@agmux/protocol";
import { LIVE_STATUSES } from "@agmux/protocol";
import { computeEffectiveStatus } from "./lost.ts";

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
  };
}

export function getSessionRaw(db: Database, sid: string, now: Date): SessionRow | null {
  const raw = db.query<any, [string]>(`SELECT * FROM sessions WHERE session_id = ?`).get(sid);
  if (!raw) return null;
  const r = decodeRow(raw);
  r.status = computeEffectiveStatus(r, now);
  return r;
}

export interface ListSessionsOpts {
  live?: boolean;
  agent_kind?: string;
  profile?: string;
  since?: string;
  limit?: number;
  now?: Date;
}

export function listSessions(db: Database, opts: ListSessionsOpts): SessionRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.agent_kind) { where.push("agent_kind = ?"); params.push(opts.agent_kind); }
  if (opts.profile)    { where.push("profile = ?");    params.push(opts.profile); }
  if (opts.since)      { where.push("start_ts >= ?");  params.push(opts.since); }
  const sql = `SELECT s.*, u.turn_count FROM sessions s
               LEFT JOIN session_usage u ON u.session_id = s.session_id
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY start_ts DESC
               LIMIT ?`;
  params.push(opts.limit ?? 200);
  const raws = db.query<any, any[]>(sql).all(...(params as any[]));
  const now = opts.now ?? new Date();
  let rows = raws.map(decodeRow).map((r) => {
    r.status = computeEffectiveStatus(r, now);
    return r;
  });
  if (opts.live) rows = rows.filter((r) => LIVE_STATUSES.includes(r.status));
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
