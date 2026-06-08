import { LOST_THRESHOLD_MS, type SessionStatus, type SessionOrigin, TERMINAL_STATUSES } from "@agmux/protocol";

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
