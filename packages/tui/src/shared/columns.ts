import type { SessionRow } from "@agmux/protocol";
import { relTime } from "./reltime.ts";
import { activityCell } from "../format.ts";

// Every column the dash can show, in no particular order. The visible set and
// its order come from `[dash] columns` (DEFAULT_COLUMNS when unset).
export const COLUMN_KEYS = [
  "glyph", "name", "repo", "branch", "last_seen",
  "id", "agent", "profile", "tmux", "turns", "activity", "project",
] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export const DEFAULT_COLUMNS: ColumnKey[] = ["glyph", "name", "repo", "branch", "last_seen"];

export function isColumnKey(s: string): s is ColumnKey {
  return (COLUMN_KEYS as readonly string[]).includes(s);
}

// How a column is coloured — a role, not a hex, so the palette stays in one place:
//   state  status colour (the glyph; the name, also bold)
//   faint  dim chrome (repo)
//   accent pink — the one non-status hue, for the branch
//   sub    secondary text (every other optional column)
//   age    text fading with age (last_seen)
export type ColumnStyle = "state" | "faint" | "accent" | "sub" | "age";

export interface ColDef {
  key: ColumnKey;
  header: string;
  align: "left" | "right";
  style: ColumnStyle;
  // Hard cap, applied to the cell text (with an ellipsis) before fitting.
  max?: number;
  // Floor when the table is squeezed to fit; absent = never shrinks.
  min?: number;
  text: (r: SessionRow, now: number) => string;
  // How the text is shortened to a width (default `clip`: tail + ellipsis).
  shorten?: (s: string, width: number) => string;
}

const ID_MAX = 13;

// Sessions without a reported name fall back to the short id so a row is never blank.
function nameText(r: SessionRow): string {
  return r.name || r.session_id.slice(0, ID_MAX);
}

function tmuxText(r: SessionRow): string {
  return r.tmux_session && r.tmux_window ? `${r.tmux_session}:${r.tmux_window}` : "";
}

export const COLUMNS: Record<ColumnKey, ColDef> = {
  // The cell is a width placeholder; SessionTable draws the (animated) glyph.
  glyph: { key: "glyph", header: "", align: "left", style: "state", text: () => " " },
  name: { key: "name", header: "NAME", align: "left", style: "state", max: 40, min: 12, text: nameText },
  repo: { key: "repo", header: "REPO", align: "left", style: "faint", max: 24, min: 6, text: (r) => r.git_repo ?? "" },
  // Floor 12 = "f…/" + 8 chars of the branch name + "…" (see abbreviateBranch).
  branch: {
    key: "branch", header: "BRANCH", align: "left", style: "accent", max: 32, min: 12,
    text: (r) => r.git_branch ?? "", shorten: abbreviateBranch,
  },
  last_seen: {
    key: "last_seen", header: "LAST", align: "right", style: "age",
    text: (r, now) => relTime(r.last_heartbeat_ts ?? r.start_ts, now),
  },
  // Opaque id: a hard cut, no ellipsis.
  id: { key: "id", header: "ID", align: "left", style: "sub", text: (r) => r.session_id.slice(0, ID_MAX) },
  agent: { key: "agent", header: "AGENT", align: "left", style: "sub", text: (r) => r.agent_kind },
  profile: { key: "profile", header: "PROFILE", align: "left", style: "sub", max: 16, min: 6, text: (r) => r.profile ?? "" },
  tmux: { key: "tmux", header: "TMUX", align: "left", style: "sub", max: 32, min: 6, text: tmuxText },
  turns: {
    key: "turns", header: "TURNS", align: "right", style: "sub",
    text: (r) => (r.turn_count == null ? "" : String(r.turn_count)),
  },
  activity: {
    key: "activity", header: "ACTIVITY", align: "left", style: "sub", max: 40, min: 8,
    text: (r) => { const a = activityCell(r); return a === "-" ? "" : a; },
  },
  project: { key: "project", header: "PROJECT", align: "left", style: "sub", max: 24, min: 6, text: (r) => r.project ?? "" },
};

// Squeeze order when the row is wider than the pane: the least identifying
// columns give way first, the name last.
const SHRINK_ORDER: ColumnKey[] = ["activity", "tmux", "project", "profile", "branch", "repo", "name"];

// Column separation: the glyph hugs the name it qualifies (1 space); every
// other column gets a wide 5-space gutter so the columns read apart at a glance.
const GLYPH_GAP = " ";
const GAP = "     ";

// Whitespace after the column at `idx` (none after the last).
export function gapAfter(cols: ColumnKey[], idx: number): string {
  if (idx >= cols.length - 1) return "";
  return cols[idx] === "glyph" ? GLYPH_GAP : GAP;
}

// Conventional branch prefixes collapse to their initial when the branch
// doesn't fit, leaving the room for the part that tells branches apart:
//   feature/long_branch_name → f…/long_bra…
const BRANCH_PREFIX = /^(feature|feat|bugfix|bug|chore|hotfix)\/(.+)$/;

export function abbreviateBranch(s: string, width: number): string {
  if (s.length <= width) return s;
  const m = BRANCH_PREFIX.exec(s);
  if (!m) return clip(s, width);
  const prefix = `${m[1]![0]}…/`;
  return prefix + clip(m[2]!, width - prefix.length);
}

export function clip(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 0) return "";
  return s.slice(0, width - 1) + "…";
}

export type RowCells = Partial<Record<ColumnKey, string>>;
// Widths of the visible columns only.
export type Widths = Partial<Record<ColumnKey, number>>;

export function rowCells(r: SessionRow, cols: ColumnKey[], now: number): RowCells {
  const out: RowCells = {};
  for (const k of cols) {
    const def = COLUMNS[k];
    const t = def.text(r, now);
    out[k] = def.max ? (def.shorten ?? clip)(t, def.max) : t;
  }
  return out;
}

// Content-sized: max(widest cell, header when the header row is shown).
export function columnWidths(cols: ColumnKey[], cells: RowCells[], withHeader: boolean): Widths {
  const w: Widths = {};
  for (const k of cols) {
    if (k === "glyph") { w[k] = 1; continue; }
    w[k] = cells.reduce((m, cell) => Math.max(m, cell[k]?.length ?? 0), withHeader ? COLUMNS[k].header.length : 0);
  }
  return w;
}

export function rowWidth(cols: ColumnKey[], widths: Widths): number {
  return cols.reduce((sum, k, i) => sum + (widths[k] ?? 0) + gapAfter(cols, i).length, 0);
}

// Shrink columns (in SHRINK_ORDER, each down to its floor) until the row fits
// `available`. Anything still too wide after that is clipped by the renderer.
export function fitWidths(cols: ColumnKey[], widths: Widths, available: number): Widths {
  const out = { ...widths };
  let excess = rowWidth(cols, out) - available;
  for (const k of SHRINK_ORDER) {
    if (excess <= 0) break;
    const w = out[k];
    if (w === undefined || !cols.includes(k)) continue;
    const give = Math.min(excess, Math.max(0, w - (COLUMNS[k].min ?? w)));
    out[k] = w - give;
    excess -= give;
  }
  return out;
}

export function pad(s: string, width: number, align: "left" | "right"): string {
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}

// Clip-then-pad: the one way a cell becomes exactly `width` columns.
export function fitCell(
  s: string, width: number, align: "left" | "right", shorten: (s: string, width: number) => string = clip,
): string {
  return pad(shorten(s, width), width, align);
}
