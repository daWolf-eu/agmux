import { LOST_THRESHOLD_MS, type SessionStatus, TERMINAL_STATUSES } from "@agmux/protocol";

interface RowForLostCheck {
  status: SessionStatus;
  start_ts: string;
  last_heartbeat_ts: string | null;
}

export function computeEffectiveStatus(row: RowForLostCheck, now: Date = new Date()): SessionStatus {
  if (TERMINAL_STATUSES.includes(row.status)) return row.status;
  const lastSeen = new Date(row.last_heartbeat_ts ?? row.start_ts).getTime();
  if (now.getTime() - lastSeen > LOST_THRESHOLD_MS) return "lost";
  return row.status;
}
