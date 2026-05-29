import type { Database } from "bun:sqlite";
import type { EventEnvelope } from "@agmux/protocol";

export function applyEventToProjection(db: Database, ev: EventEnvelope): void {
  switch (ev.kind) {
    case "session.started":
      applyStarted(db, ev);
      return;
    case "session.heartbeat":
      applyHeartbeat(db, ev);
      return;
    case "session.resumed":
      applyResumed(db, ev);
      return;
    case "session.ended":
      applyEnded(db, ev);
      return;
    case "session.linked":
      applyLinked(db, ev);
      return;
    case "turn.started":
      applyLiveStatus(db, ev, "running");
      bumpTurnCount(db, ev);
      return;
    case "turn.ended":
      applyLiveStatus(db, ev, "idle");
      return;
    case "input.required":
      applyLiveStatus(db, ev, "waiting");
      return;
    case "input.received":
      applyLiveStatus(db, ev, "running");
      return;
    case "usage.reported":
      applyUsage(db, ev);
      return;
    case "session.adapter_attached":
      applyAdapterAttached(db, ev);
      return;
    // tool.used / prompt.sent are known but log-only: no projection effect.
    default:
      // Unknown kinds are stored in events but do not touch the projection.
      return;
  }
}

function applyStarted(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`
    INSERT INTO sessions (
      session_id, agent_kind, profile, native_session_id,
      command, args_json, env_json, cwd, pid,
      tmux_session, tmux_window, tmux_pane, host,
      project, parent_session_id, start_ts, last_heartbeat_ts,
      end_ts, exit_code, signal, status
    ) VALUES (
      ?, ?, ?, NULL,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, NULL, ?, NULL,
      NULL, NULL, NULL, 'idle'
    )
    ON CONFLICT(session_id) DO NOTHING
  `).run(
    ev.session_id, p.agent_kind, p.profile ?? null,
    p.command, JSON.stringify(p.args ?? []), JSON.stringify(p.env_overrides ?? {}), p.cwd, p.pid,
    p.tmux_session ?? null, p.tmux_window ?? null, p.tmux_pane ?? null, ev.host,
    p.project ?? null, ev.ts,
  );
}

function applyHeartbeat(db: Database, ev: EventEnvelope): void {
  db.query(`
    UPDATE sessions
       SET last_heartbeat_ts = ?
     WHERE session_id = ?
       AND status NOT IN ('ended')
  `).run(ev.ts, ev.session_id);
}

function applyResumed(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`
    UPDATE sessions
       SET pid = ?,
           tmux_session = ?,
           tmux_window = ?,
           tmux_pane = ?,
           last_heartbeat_ts = ?,
           end_ts = NULL,
           exit_code = NULL,
           signal = NULL,
           status = 'idle'
     WHERE session_id = ?
  `).run(
    p.new_pid,
    p.new_tmux_session ?? null,
    p.new_tmux_window ?? null,
    p.new_tmux_pane ?? null,
    ev.ts,
    ev.session_id,
  );
}

function applyEnded(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`
    UPDATE sessions
       SET end_ts = ?,
           exit_code = ?,
           signal = ?,
           status = 'ended'
     WHERE session_id = ?
  `).run(ev.ts, p.exit_code ?? null, p.signal ?? null, ev.session_id);
}

// Live status transitions are guarded: they apply only to a non-ended row, so
// an out-of-order or stray adapter event can never resurrect a dead session.
// (`lost` is computed at read time in lost.ts, not stored, so the stored status
// here is only idle/running/waiting/ended; excluding 'ended' == "still live".)
function applyLiveStatus(db: Database, ev: EventEnvelope, status: "running" | "idle" | "waiting"): void {
  db.query(`
    UPDATE sessions SET status = ?
     WHERE session_id = ? AND status NOT IN ('ended')
  `).run(status, ev.session_id);
}

function applyLinked(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`UPDATE sessions SET native_session_id = ? WHERE session_id = ?`)
    .run(p.native_session_id, ev.session_id);
}

function applyAdapterAttached(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`UPDATE sessions SET adapter_capabilities = ? WHERE session_id = ?`)
    .run(JSON.stringify(p.capabilities ?? {}), ev.session_id);
}

function ensureUsageRow(db: Database, sessionId: string): void {
  db.query(`INSERT INTO session_usage (session_id) VALUES (?) ON CONFLICT(session_id) DO NOTHING`)
    .run(sessionId);
}

function bumpTurnCount(db: Database, ev: EventEnvelope): void {
  ensureUsageRow(db, ev.session_id);
  db.query(`UPDATE session_usage SET turn_count = turn_count + 1 WHERE session_id = ?`)
    .run(ev.session_id);
}

function n(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

function applyUsage(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  ensureUsageRow(db, ev.session_id);
  const rl = p.rate_limit == null ? null : JSON.stringify(p.rate_limit);
  if (p.cumulative === true) {
    // Provider already summed: replace token totals with the reported figures.
    db.query(`
      UPDATE session_usage SET
        input_tokens = ?, output_tokens = ?, reasoning_output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?,
        last_model = COALESCE(?, last_model),
        last_rate_limit = COALESCE(?, last_rate_limit)
      WHERE session_id = ?
    `).run(
      n(p.input_tokens), n(p.output_tokens), n(p.reasoning_output_tokens),
      n(p.cache_read_tokens), n(p.cache_write_tokens), n(p.cost_usd),
      p.model ?? null, rl, ev.session_id,
    );
  } else {
    // Per-turn delta: accumulate.
    db.query(`
      UPDATE session_usage SET
        input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
        reasoning_output_tokens = reasoning_output_tokens + ?,
        cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?,
        cost_usd = cost_usd + ?,
        last_model = COALESCE(?, last_model),
        last_rate_limit = COALESCE(?, last_rate_limit)
      WHERE session_id = ?
    `).run(
      n(p.input_tokens), n(p.output_tokens), n(p.reasoning_output_tokens),
      n(p.cache_read_tokens), n(p.cache_write_tokens), n(p.cost_usd),
      p.model ?? null, rl, ev.session_id,
    );
  }
}
