import type { SessionRow } from "@agmux/protocol";
import { MOCHA } from "./palette.ts";

export interface Glyph {
  glyph: string;
  color: string;
}

// Colour answers "what do I have to do", not "what is the process doing":
//   yellow   waiting — needs you (red stays reserved for errors)
//   green    done    — finished and not yet seen
//   lavender running — busy, nothing to do (deliberately neutral)
//   grey     idle    — seen / quiet, fainter than text
//   dimmer   closed  — ended cleanly or lost
//   red      error   — ended non-zero or on a signal
// Shape repeats the state so the glyph reads without colour: `?` waiting, a
// braille spinner while running (motion = working), `●` unseen, `○` seen, `·`
// gone. Single-width BMP glyphs only (no emoji / nerdfont), so they render as
// plain text on any terminal.
export type StatusTone = "waiting" | "done" | "running" | "idle" | "error" | "closed";

export const STATUS_COLORS: Record<StatusTone, string> = {
  waiting: MOCHA.yellow,
  done: MOCHA.green,
  running: MOCHA.lavender,
  idle: MOCHA.overlay2,
  error: MOCHA.red,
  closed: MOCHA.surface2,
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_MS = 100;

// Legend / tone order: most urgent first, matching the default status sort.
export const TONES: StatusTone[] = ["waiting", "done", "running", "idle", "closed", "error"];

// `frame` advances the running spinner; static surfaces (the tmux status line)
// pass nothing and get the first frame.
export function toneGlyph(tone: StatusTone, frame = 0): string {
  switch (tone) {
    case "waiting": return "?";
    case "running": return SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length]!;
    case "done": return "●";
    case "idle": return "○";
    case "error":
    case "closed": return "·";
  }
}

// `lost` is treated as closed (muted), not error. Only an `ended` session that
// exited non-zero or on a signal earns the red error colour.
export function statusTone(r: SessionRow): StatusTone {
  switch (r.status) {
    case "waiting": return "waiting";
    case "running": return "running";
    case "done": return "done";
    case "idle": return "idle";
    case "ended":
      return (r.exit_code != null && r.exit_code !== 0) || r.signal ? "error" : "closed";
    case "lost": return "closed";
    default: return "closed";
  }
}

// `done` is the only unseen status: a waiting session needs action, not
// reading, and running/idle have nothing new to look at.
export function isUnread(r: SessionRow): boolean {
  return r.status === "done";
}

export function statusGlyph(r: SessionRow, frame = 0): Glyph {
  const tone = statusTone(r);
  return { glyph: toneGlyph(tone, frame), color: STATUS_COLORS[tone] };
}
