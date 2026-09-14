import type { SessionRow } from "@agmux/protocol";

export interface Glyph {
  glyph: string;
  color: string;
}

// Two independent axes, so one character decodes both without a legend:
//   color → status (running / waiting / idle / error / closed)
//   shape → read-ness (unread = solid, read = outlined)
// Geometric, single-width BMP glyphs (no emoji / nerdfont): they render as plain
// text on any terminal and stay visually consistent.
//
// Shape is reserved for read-ness alone, so status is now carried entirely by
// colour — the former per-status shapes (`◉` waiting, `✕` error, `·` closed)
// are gone. Hard-coded for now; a future theming feature is expected to make
// both axes configurable, which is why the two maps are exported separately.
export const UNREAD_SHAPE = "●";
export const READ_SHAPE = "○";

export type StatusTone = "running" | "waiting" | "idle" | "error" | "closed";

export const STATUS_COLORS: Record<StatusTone, string> = {
  running: "#a6e3a1",
  waiting: "#f9e2af",
  idle: "#6c7086",
  error: "#f38ba8",
  // Dimmer than `idle`: shape used to separate closed from idle (`·` vs `○`),
  // so the two greys have to carry that distinction on their own now.
  closed: "#45475a",
};

// `lost` is treated as closed (muted), not error. Only an `ended` session that
// exited non-zero or on a signal earns the red error colour.
export function statusTone(r: SessionRow): StatusTone {
  switch (r.status) {
    case "waiting": return "waiting";
    case "running": return "running";
    case "idle": return "idle";
    case "ended":
      return (r.exit_code != null && r.exit_code !== 0) || r.signal ? "error" : "closed";
    case "lost": return "closed";
    default: return "closed";
  }
}

// Only an explicit `true` counts as unread: the field is optional on SessionRow
// and absent wherever the projection wasn't joined, so read is the safe default
// (matches the ?unread=1 filter predicate in @agmux/store).
export function isUnread(r: SessionRow): boolean {
  return r.unread === true;
}

export function statusGlyph(r: SessionRow): Glyph {
  return {
    glyph: isUnread(r) ? UNREAD_SHAPE : READ_SHAPE,
    color: STATUS_COLORS[statusTone(r)],
  };
}
