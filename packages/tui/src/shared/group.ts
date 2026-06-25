import {
  LIVE_STATUSES, TERMINAL_STATUSES, expandStatusFilter,
  type SessionRow,
} from "@agmux/protocol";

// The dash's activity-group filter (key `f`), distinct from the free-text
// "search" (key `/`). "open" = live, "closed" = terminal, "all" = no filter.
export type ActivityGroup = "open" | "closed" | "all";
export const GROUPS: ActivityGroup[] = ["open", "closed", "all"];

export function inGroup(r: SessionRow, g: ActivityGroup): boolean {
  if (g === "all") return true;
  if (g === "open") return LIVE_STATUSES.includes(r.status);
  return TERMINAL_STATUSES.includes(r.status);
}

export function groupRows(rows: SessionRow[], g: ActivityGroup): SessionRow[] {
  return rows.filter((r) => inGroup(r, g));
}

export function nextGroup(g: ActivityGroup): ActivityGroup {
  return GROUPS[(GROUPS.indexOf(g) + 1) % GROUPS.length]!;
}

// Map a resolved `--status`/config value to the dash's starting group. The dash
// fetches all statuses; this only picks the initial view (default "open").
export function initialGroup(status?: string): ActivityGroup {
  if (!status) return "open";
  const expanded = expandStatusFilter(status);
  if (!expanded || expanded.length === 0) return "all";
  if (expanded.every((s) => TERMINAL_STATUSES.includes(s))) return "closed";
  if (expanded.every((s) => LIVE_STATUSES.includes(s))) return "open";
  return "all";
}
