import { MOCHA } from "./palette.ts";
import { STATUS_COLORS } from "./glyph.ts";

// Relative time for the LAST column. `now` is injected (Date.now() in the app)
// so it's deterministic in tests. Recomputed each render — the feed's 1s poll
// re-render keeps "3s → 4s" live without a dedicated timer.
export function relTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "-";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d`;
  return iso.slice(0, 10);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// The older, the fainter: <1m in the running colour (a ticking age reads as
// live) · <1h text · <1d · <1w · older (barely there). Adjacent steps differ
// clearly on purpose.
export function ageColor(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return MOCHA.surface1;
  const age = Math.max(0, now - then);
  if (age < MIN) return STATUS_COLORS.running;
  if (age < HOUR) return MOCHA.text;
  if (age < DAY) return MOCHA.overlay1;
  if (age < WEEK) return MOCHA.surface2;
  return MOCHA.surface1;
}
