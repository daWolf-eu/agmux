import type { SessionRow } from "@agmux/protocol";

const ACTIVITY_MAX = 40;

// What the agent is doing right now, derived from status + the
// session_activity fields. Only running/waiting have anything to say; stale
// tool fields on idle/closed rows are deliberately not shown.
export function activityCell(r: SessionRow): string {
  if (r.status === "running") {
    if (!r.last_tool) return "working";
    const cell = `tool: ${r.last_tool}${r.last_tool_detail ? ` ${r.last_tool_detail}` : ""}`;
    return cell.length > ACTIVITY_MAX ? cell.slice(0, ACTIVITY_MAX - 1) + "…" : cell;
  }
  if (r.status === "waiting") return `input: ${r.last_input_kind ?? "input"}`;
  return "-";
}

export function formatTable(rows: SessionRow[], reverse: boolean): string[] {
  const header = ["ID", "AGENT", "PROFILE", "STATUS", "TURNS", "ACTIVITY", "PID", "TMUX", "START", "LAST_SEEN"];
  const data = rows.map((r) => [
    r.session_id.slice(0, 23),
    r.agent_kind,
    r.profile ?? "-",
    r.status,
    // "-" = no adapter observation; "0" = adapter watched but no turn happened
    // (nothing to resume); >0 = a real conversation.
    r.turn_count == null ? "-" : String(r.turn_count),
    activityCell(r),
    r.pid?.toString() ?? "-",
    r.tmux_session && r.tmux_window ? `${r.tmux_session}:${r.tmux_window}` : "-",
    short(r.start_ts),
    short(r.last_heartbeat_ts ?? r.start_ts),
  ]);
  // -r flips data rows only — the header stays on top.
  if (reverse) data.reverse();
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length))
  );
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [fmt(header), ...data.map(fmt)];
}

export function short(iso: string): string {
  // 2026-05-28T12:00:00.000Z → 05-28 12:00
  return iso.slice(5, 16).replace("T", " ");
}
