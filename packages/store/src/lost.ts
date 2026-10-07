import {
  LOST_THRESHOLD_MS, WORKING_TIMEOUT_MS, TERMINAL_STATUSES,
  type SessionStatus, type SessionOrigin, type StatusRule,
} from "@agmux/protocol";

interface RowForLostCheck {
  status: SessionStatus;
  start_ts: string;
  last_heartbeat_ts: string | null;
  // Optional so callers that only care about wrapper staleness need not pass it;
  // defaults to wrapper semantics (the historical behavior).
  origin?: SessionOrigin;
}

export function computeEffectiveStatus(row: RowForLostCheck, now: Date = new Date()): SessionStatus {
  if (TERMINAL_STATUSES.includes(row.status)) return row.status;
  // Native rows have no heartbeats: their liveness is driven by the hub's pid
  // sweep (which appends session.lost → stored status 'lost'), so heartbeat
  // staleness must NOT apply (spec §3). Report the stored status as-is.
  if (row.origin === "native") return row.status;
  const lastSeen = new Date(row.last_heartbeat_ts ?? row.start_ts).getTime();
  if (now.getTime() - lastSeen > LOST_THRESHOLD_MS) return "lost";
  return row.status;
}

export interface RowForDerive extends RowForLostCheck {
  status_ts?: string | null;
  activity_ts?: string | null;
  title_ts?: string | null;
  attention_ts?: string | null;
  seen_ts?: string | null;
}

export interface Derived {
  status: SessionStatus;
  rule: StatusRule;
  reason: string;
  last_work_ts: string | null;
}

function maxTs(...ts: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const t of ts) if (t && (best === null || t > best)) best = t;
  return best;
}

// "Unseen": an attention-worthy event (turn.ended / input.required /
// session.ended → attention_ts) newer than the last acknowledgement.
export function isUnseen(row: Pick<RowForDerive, "attention_ts" | "seen_ts">): boolean {
  return !!row.attention_ts && (!row.seen_ts || row.attention_ts > row.seen_ts);
}

// The single derivation of the status every consumer sees, from the stored
// projection status. Rules, in order:
//   1. ended/lost are final.
//   2. a wrapper row whose heartbeat went stale is lost.
//   3. running with no evidence of work for WORKING_TIMEOUT_MS decays to idle —
//      the turn ended without a Stop we could see (interrupt, crash, missed hook).
//      Evidence = the status change itself, tool events, title updates; never the
//      wrapper heartbeat, which only proves the process lives.
//   4. idle whose last attention event is unseen is `done`.
export function deriveStatus(row: RowForDerive, now: Date = new Date()): Derived {
  const lastWork = maxTs(row.status_ts, row.activity_ts, row.title_ts);
  if (TERMINAL_STATUSES.includes(row.status)) {
    return { status: row.status, rule: "terminal", reason: `stored status is ${row.status}`, last_work_ts: lastWork };
  }
  const eff = computeEffectiveStatus(row, now);
  if (eff === "lost") {
    return {
      status: "lost", rule: "heartbeat-stale", last_work_ts: lastWork,
      reason: `no wrapper heartbeat since ${row.last_heartbeat_ts ?? row.start_ts} (> ${LOST_THRESHOLD_MS / 1000}s)`,
    };
  }
  let status = row.status;
  let rule: StatusRule = "stored";
  let reason = `stored status is ${row.status}`;
  // Legacy rows without status_ts have no reliable evidence clock; leave them be.
  if (status === "running" && row.status_ts && lastWork && now.getTime() - Date.parse(lastWork) >= WORKING_TIMEOUT_MS) {
    status = "idle";
    rule = "working-timeout";
    reason = `running, but no evidence of work since ${lastWork} (>= ${WORKING_TIMEOUT_MS / 1000}s)`;
  }
  if (status === "idle" && isUnseen(row)) {
    return {
      status: "done", rule: "unseen", last_work_ts: lastWork,
      reason: `${rule === "working-timeout" ? reason + "; " : ""}attention at ${row.attention_ts} is newer than seen at ${row.seen_ts ?? "never"}`,
    };
  }
  return { status, rule, reason, last_work_ts: lastWork };
}
