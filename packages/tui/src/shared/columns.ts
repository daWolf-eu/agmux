import type { SessionRow } from "@agmux/protocol";
import { relTime } from "./reltime.ts";

export const ID_MAX = 13;
export const TMUX_MAX = 32;

export interface RowCells {
  id: string;
  tmux: string;
  agent: string;
  profile: string;
  turns: string;
  last: string;
}

export type ColKey = keyof RowCells;

export interface ColDef {
  key: ColKey;
  header: string;
  align: "left" | "right";
}

// Column order: glyph is rendered separately (leading), so it is NOT in COLS.
export const COLS: ColDef[] = [
  { key: "id", header: "ID", align: "left" },
  { key: "tmux", header: "TMUX", align: "left" },
  { key: "agent", header: "AGENT", align: "left" },
  { key: "profile", header: "PROFILE", align: "left" },
  { key: "turns", header: "TURNS", align: "right" },
  { key: "last", header: "LAST", align: "right" },
];

// ID: first 13 chars, NO ellipsis (it's an opaque id; a hard cut is fine).
function idCell(r: SessionRow): string {
  return r.session_id.slice(0, ID_MAX);
}

// TMUX: session:window, truncated to 32 WITH ellipsis (human-chosen, worth reading).
function tmuxCell(r: SessionRow): string {
  if (!r.tmux_session || !r.tmux_window) return "—";
  const c = `${r.tmux_session}:${r.tmux_window}`;
  return c.length > TMUX_MAX ? c.slice(0, TMUX_MAX - 1) + "…" : c;
}

export function rowCells(r: SessionRow, now: number): RowCells {
  return {
    id: idCell(r),
    tmux: tmuxCell(r),
    agent: r.agent_kind,
    profile: r.profile ?? "-",
    turns: r.turn_count == null ? "-" : String(r.turn_count),
    last: relTime(r.last_heartbeat_ts ?? r.start_ts, now),
  };
}

export function columnWidths(cells: RowCells[]): Record<ColKey, number> {
  const w = {} as Record<ColKey, number>;
  for (const c of COLS) w[c.key] = c.header.length;
  for (const cell of cells) for (const c of COLS) w[c.key] = Math.max(w[c.key], cell[c.key].length);
  return w;
}

export function pad(s: string, width: number, align: "left" | "right"): string {
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}
