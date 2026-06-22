import type { SessionRow } from "@agmux/protocol";

export interface Glyph {
  glyph: string;
  color: string;
}

// Geometric, single-width BMP glyphs (no emoji / nerdfont): they render as plain
// text on any terminal and stay visually consistent. `◉` (needs-input) is the
// attention member of the same circle family as `●` running / `○` idle.
const RUNNING: Glyph = { glyph: "●", color: "#a6e3a1" };
const WAITING: Glyph = { glyph: "◉", color: "#f9e2af" };
const IDLE: Glyph = { glyph: "○", color: "#6c7086" };
const ERROR: Glyph = { glyph: "✕", color: "#f38ba8" };
const CLOSED: Glyph = { glyph: "·", color: "#585b70" };

// `lost` is treated as closed (muted), not error. Only an `ended` session that
// exited non-zero or on a signal earns the red error glyph.
export function statusGlyph(r: SessionRow): Glyph {
  switch (r.status) {
    case "waiting": return WAITING;
    case "running": return RUNNING;
    case "idle": return IDLE;
    case "ended":
      return (r.exit_code != null && r.exit_code !== 0) || r.signal ? ERROR : CLOSED;
    case "lost": return CLOSED;
    default: return CLOSED;
  }
}
