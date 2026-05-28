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
