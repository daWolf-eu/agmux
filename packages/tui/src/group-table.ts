import type { SessionRow, SessionStatus } from "@agmux/protocol";
import { activityCell, short } from "./format.ts";

export type GroupKey = "waiting" | "running" | "idle" | "closed";

interface GroupDef { key: GroupKey; label: string; statuses: SessionStatus[]; }

// Fixed display order — needs-input first (spec §4).
const GROUP_DEFS: GroupDef[] = [
  { key: "waiting", label: "NEEDS INPUT", statuses: ["waiting"] },
  { key: "running", label: "WORKING", statuses: ["running"] },
  { key: "idle", label: "IDLE", statuses: ["idle"] },
  { key: "closed", label: "CLOSED", statuses: ["ended", "lost"] },
];

export const DASH_HEADER = ["ID", "AGENT", "PROFILE", "ACTIVITY", "TURNS", "LAST"] as const;

// Activity text for the dash table: reuse activityCell for live rows; closed
// rows show how they ended instead of "-".
export function dashActivityCell(r: SessionRow): string {
  if (r.status === "ended") return r.signal ? `signal ${r.signal}` : `exited ${r.exit_code ?? "?"}`;
  if (r.status === "lost") return "lost";
  return activityCell(r);
}

function cells(r: SessionRow): string[] {
  return [
    r.session_id.slice(0, 8),
    r.agent_kind,
    r.profile ?? "-",
    dashActivityCell(r),
    r.turn_count == null ? "-" : String(r.turn_count),
    short(r.last_heartbeat_ts ?? r.start_ts),
  ];
}

export function groupSessions(rows: SessionRow[]): { key: GroupKey; label: string; rows: SessionRow[] }[] {
  return GROUP_DEFS
    .map((d) => ({ key: d.key, label: d.label, rows: rows.filter((r) => d.statuses.includes(r.status)) }))
    .filter((g) => g.rows.length > 0);
}

export interface DashRow { row: SessionRow; text: string; }
export interface DashGroup { key: GroupKey; label: string; count: number; rows: DashRow[]; }
export interface DashTable { header: string; groups: DashGroup[]; }

export function buildDashTable(rows: SessionRow[]): DashTable {
  const groups = groupSessions(rows);
  const all = groups.flatMap((g) => g.rows);
  const cellMap = new Map<string, string[]>();
  for (const r of all) cellMap.set(r.session_id, cells(r));
  const widths = DASH_HEADER.map((h, i) =>
    all.length ? Math.max(h.length, ...all.map((r) => cellMap.get(r.session_id)![i]!.length)) : h.length,
  );
  const fmt = (c: readonly string[]) => c.map((x, i) => x.padEnd(widths[i]!)).join("  ");
  return {
    header: fmt(DASH_HEADER),
    groups: groups.map((g) => ({
      key: g.key, label: g.label, count: g.rows.length,
      rows: g.rows.map((r) => ({ row: r, text: fmt(cellMap.get(r.session_id)!) })),
    })),
  };
}

// Flat selectable order in group order — drives j/k navigation.
export function selectableRows(rows: SessionRow[]): SessionRow[] {
  return groupSessions(rows).flatMap((g) => g.rows);
}

export function matchesFilter(r: SessionRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [r.session_id, r.agent_kind, r.profile ?? "", dashActivityCell(r)]
    .some((s) => s.toLowerCase().includes(needle));
}
