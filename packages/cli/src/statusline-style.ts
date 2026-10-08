import { LINE_TONES, type LineTone, type StatusLineStyle } from "@agmux/tui";
import type { StatuslineConfig } from "./attention-config.ts";

// The status line's look can live in tmux.conf, next to the theme it has to
// match: these tmux options override the [statusline] keys of config.toml.
// Unset (or empty) options fall through.
export const TMUX_STYLE_OPTIONS = {
  format: "@agmux-statusline-format",
  chip: "@agmux-statusline-chip",
  overflow: "@agmux-statusline-overflow",
  filter: "@agmux-statusline-filter",
  separator: "@agmux-statusline-separator",
  ...Object.fromEntries(LINE_TONES.map((t) => [`color_${t}`, `@agmux-statusline-color-${t}`])),
} as Record<string, string>;

const KEYS = Object.keys(TMUX_STYLE_OPTIONS);
const SEP = "\x1f";

export type TmuxStyle = Partial<Record<string, string>>;

export type Capture = (cmd: string, args: string[]) => Promise<string>;

// One `display -p` for every option (the values come back raw: tmux doesn't
// expand an option's value inside #{…}). Empty when tmux isn't running.
export async function readTmuxStyle(capture: Capture): Promise<TmuxStyle> {
  try {
    const fmt = KEYS.map((k) => `#{${TMUX_STYLE_OPTIONS[k]}}`).join(SEP);
    const values = (await capture("tmux", ["display-message", "-p", fmt])).replace(/\n$/, "").split(SEP);
    const out: TmuxStyle = {};
    KEYS.forEach((k, i) => { if (values[i]) out[k] = values[i]; });
    return out;
  } catch {
    return {};
  }
}

// tmux options over config.toml; DEFAULT_STYLE (in the renderer) fills the rest.
export function resolveLineStyle(
  cfg: StatuslineConfig, tmux: TmuxStyle,
): { format: string; style: Partial<StatusLineStyle> } {
  const colors: Partial<Record<LineTone, string>> = { ...cfg.style.colors };
  for (const t of LINE_TONES) if (tmux[`color_${t}`]) colors[t] = tmux[`color_${t}`];
  const style: Partial<StatusLineStyle> = { ...cfg.style, colors };
  for (const k of ["chip", "overflow", "filter", "separator"] as const) if (tmux[k]) style[k] = tmux[k];
  return { format: tmux.format ?? cfg.format, style };
}
