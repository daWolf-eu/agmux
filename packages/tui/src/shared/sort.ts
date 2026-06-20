import type { SessionRow, SessionStatus } from "@agmux/protocol";

export type SortKey = "status" | "last" | "id";
export const SORT_KEYS: SortKey[] = ["status", "last", "id"];

// Needs-input first, then working, then idle, then closed (ended/lost share a rank).
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0, running: 1, idle: 2, ended: 3, lost: 3,
};

function tsOf(r: SessionRow): number {
  return Date.parse(r.last_heartbeat_ts ?? r.start_ts) || 0;
}

// Returns a NEW sorted array; never mutates the input.
export function sortRows(rows: SessionRow[], key: SortKey): SessionRow[] {
  const copy = [...rows];
  if (key === "status") {
    copy.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || tsOf(b) - tsOf(a));
  } else if (key === "last") {
    copy.sort((a, b) => tsOf(b) - tsOf(a));
  } else {
    copy.sort((a, b) => a.session_id.localeCompare(b.session_id));
  }
  return copy;
}

export function nextSort(key: SortKey): SortKey {
  return SORT_KEYS[(SORT_KEYS.indexOf(key) + 1) % SORT_KEYS.length]!;
}
