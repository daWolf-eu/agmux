import type { SessionRow } from "@agmux/protocol";

export function matchesFilter(r: SessionRow, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [r.session_id, r.agent_kind, r.profile ?? "", r.tmux_session ?? "", r.tmux_window ?? "", r.status]
    .some((s) => s.toLowerCase().includes(n));
}

export function filterRows(rows: SessionRow[], q: string): SessionRow[] {
  return rows.filter((r) => matchesFilter(r, q));
}
