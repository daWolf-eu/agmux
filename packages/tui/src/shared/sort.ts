import type { SessionRow, SessionStatus } from "@agmux/protocol";
import { COLUMNS, type ColumnKey } from "./columns.ts";

// The dash sorts by one visible column (key `s` cycles them); last-seen
// (newest first) always breaks ties.
export type SortKey = ColumnKey;
export const DEFAULT_SORT: SortKey = "glyph";

// The glyph column sorts by urgency: needs you > finished-unseen > working >
// quiet (idle and closed share a rank, so they interleave by recency).
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0, done: 1, running: 2, idle: 3, ended: 3, lost: 3,
};

function tsOf(r: SessionRow): number {
  return Date.parse(r.last_heartbeat_ts ?? r.start_ts) || 0;
}

// Text columns sort a→z with blanks last; glyph/turns/last_seen sort "most first".
export function sortDirection(key: SortKey): "asc" | "desc" {
  return key === "glyph" || key === "last_seen" || key === "turns" ? "desc" : "asc";
}

function byText(key: ColumnKey) {
  const text = COLUMNS[key].text;
  return (a: SessionRow, b: SessionRow): number => {
    const x = text(a, 0);
    const y = text(b, 0);
    if (!x !== !y) return x ? -1 : 1;
    return x.localeCompare(y);
  };
}

function primary(key: SortKey): (a: SessionRow, b: SessionRow) => number {
  switch (key) {
    case "glyph": return (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status];
    case "last_seen": return () => 0;
    case "turns": return (a, b) => (b.turn_count ?? -1) - (a.turn_count ?? -1);
    default: return byText(key);
  }
}

// Returns a NEW sorted array; never mutates the input.
export function sortRows(rows: SessionRow[], key: SortKey): SessionRow[] {
  const cmp = primary(key);
  return [...rows].sort((a, b) => cmp(a, b) || tsOf(b) - tsOf(a));
}

// Cycle through the visible columns, in display order. A key that isn't
// visible (e.g. the default glyph sort with no glyph column) restarts at the first.
export function nextSort(key: SortKey, cols: ColumnKey[]): SortKey {
  if (cols.length === 0) return key;
  const i = cols.indexOf(key);
  return cols[(i + 1) % cols.length]!;
}
