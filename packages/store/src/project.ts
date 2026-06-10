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
    case "session.registered":
      applyRegistered(db, ev);
      return;
    case "session.lost":
      applyLost(db, ev);
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
// We also bump last_heartbeat_ts: the column means "last proof of life", and an
// adapter activity event is exactly that. Native rows never heartbeat (pid-sweep
// liveness), so this is what makes their LAST_SEEN / activity-sort meaningful;
// for wrapper rows it only adds evidence (the process clearly ran a turn), so
// staleness-based lost detection gets more accurate, never less.
function applyLiveStatus(db: Database, ev: EventEnvelope, status: "running" | "idle" | "waiting"): void {
  db.query(`
    UPDATE sessions SET status = ?, last_heartbeat_ts = ?
     WHERE session_id = ? AND status NOT IN ('ended')
  `).run(status, ev.ts, ev.session_id);
}

// A WRAPPER session is FROZEN after session.ended: identity/usage refinements are
// dropped so a SessionEnd-hook summarizer (`claude -p` inheriting the claim) can't
// pollute the dead session. NATIVE rows are never frozen — they legitimately
// reopen on re-registration (applyRegistered) and never receive session.ended.
function isFrozen(db: Database, sessionId: string): boolean {
  const row = db.query<{ status: string; origin: string }, [string]>(
    `SELECT status, origin FROM sessions WHERE session_id = ?`,
  ).get(sessionId);
  return row?.status === "ended" && row?.origin === "wrapper";
}

function applyLinked(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`UPDATE sessions SET native_session_id = ? WHERE session_id = ? AND status NOT IN ('ended')`)
    .run(p.native_session_id, ev.session_id);
}

// The native lifecycle root (spec §2.3). Keyed by the ALREADY-RESOLVED canonical
// session_id (resolveIngest picked it). We branch only on the current row state:
//   absent           → mint a fresh native row from the payload
//   ended/lost       → reopen (rule 1): back to idle, clear terminal fields
//   live             → set native_session_id (covers claim, rotate, and re-register)
// Then resolve the optional parent lineage hint (spec §5); unresolvable → leave null.
function applyRegistered(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  const existing = db.query<{ status: string }, [string]>(
    `SELECT status FROM sessions WHERE session_id = ?`,
  ).get(ev.session_id);

  if (!existing) {
    db.query(`
      INSERT INTO sessions (
        session_id, agent_kind, profile, native_session_id,
        command, args_json, env_json, cwd, pid,
        tmux_session, tmux_window, tmux_pane, host,
        project, parent_session_id, start_ts, last_heartbeat_ts,
        end_ts, exit_code, signal, status, origin
      ) VALUES (
        ?, ?, ?, ?,
        ?, '[]', '{}', ?, ?,
        ?, ?, ?, ?,
        NULL, NULL, ?, NULL,
        NULL, NULL, NULL, 'idle', 'native'
      )
      ON CONFLICT(session_id) DO NOTHING
    `).run(
      ev.session_id, p.agent_kind, p.profile ?? null, p.native_session_id,
      p.command ?? p.agent_kind, p.cwd ?? "", p.pid ?? null,
      p.tmux_session ?? null, p.tmux_window ?? null, p.tmux_pane ?? null, ev.host,
      ev.ts,
    );
  } else if (existing.status === "ended" || existing.status === "lost") {
    db.query(`
      UPDATE sessions SET
        status = 'idle', end_ts = NULL, exit_code = NULL, signal = NULL,
        native_session_id = ?,
        pid = COALESCE(?, pid),
        tmux_session = COALESCE(?, tmux_session),
        tmux_window  = COALESCE(?, tmux_window),
        tmux_pane    = COALESCE(?, tmux_pane)
      WHERE session_id = ?
    `).run(p.native_session_id, p.pid ?? null, p.tmux_session ?? null, p.tmux_window ?? null, p.tmux_pane ?? null, ev.session_id);
  } else {
    db.query(`
      UPDATE sessions SET
        native_session_id = ?,
        pid = COALESCE(?, pid),
        tmux_session = COALESCE(?, tmux_session),
        tmux_window  = COALESCE(?, tmux_window),
        tmux_pane    = COALESCE(?, tmux_pane)
      WHERE session_id = ?
    `).run(p.native_session_id, p.pid ?? null, p.tmux_session ?? null, p.tmux_window ?? null, p.tmux_pane ?? null, ev.session_id);
  }

  const par = p.parent;
  if (par && typeof par.agent_kind === "string" && typeof par.native_session_id === "string") {
    const pr = db.query<{ session_id: string }, [string, string, string]>(
      `SELECT session_id FROM sessions WHERE agent_kind = ? AND native_session_id = ? AND host = ?`,
    ).get(par.agent_kind, par.native_session_id, ev.host);
    if (pr) {
      db.query(`UPDATE sessions SET parent_session_id = ? WHERE session_id = ? AND parent_session_id IS NULL`)
        .run(pr.session_id, ev.session_id);
    }
  }
}

// Hub-emitted pid-sweep observation (spec §3). A dead native pid → 'lost'. Never
// overrides 'ended' (a clean exit already happened); 'lost' is itself terminal.
function applyLost(db: Database, ev: EventEnvelope): void {
  db.query(`UPDATE sessions SET status = 'lost' WHERE session_id = ? AND status NOT IN ('ended')`)
    .run(ev.session_id);
}

function applyAdapterAttached(db: Database, ev: EventEnvelope): void {
  const p = ev.payload as any;
  db.query(`UPDATE sessions SET adapter_capabilities = ? WHERE session_id = ? AND status NOT IN ('ended')`)
    .run(JSON.stringify(p.capabilities ?? {}), ev.session_id);
}

function ensureUsageRow(db: Database, sessionId: string): void {
  db.query(`INSERT INTO session_usage (session_id) VALUES (?) ON CONFLICT(session_id) DO NOTHING`)
    .run(sessionId);
}

function bumpTurnCount(db: Database, ev: EventEnvelope): void {
  if (isFrozen(db, ev.session_id)) return;
  ensureUsageRow(db, ev.session_id);
  db.query(`UPDATE session_usage SET turn_count = turn_count + 1 WHERE session_id = ?`)
    .run(ev.session_id);
}

function n(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

function applyUsage(db: Database, ev: EventEnvelope): void {
  if (isFrozen(db, ev.session_id)) return; // telemetry frozen on death for wrapper sessions (see isFrozen)
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
