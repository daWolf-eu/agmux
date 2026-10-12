import { statusWidth } from "@agmux/tui";
import type { Capture } from "./statusline-style.ts";

// How many cells the status line may take. tmux clips status-left/right at
// their -length option (and at the client's width) from the end, where the
// filter chip sits; formatStatusLine fits the line into this budget instead.
//   @agmux-statusline-width  explicit budget, for placements we can't see
//   status-right / -left     whichever holds @agmux-chips: its -length, capped
//                            at the narrowest client, less the rest of it
//   status-format[1]         (status2) the narrowest client's width
// Undefined = no limit: chips placed elsewhere, no client attached, no tmux.
export const WIDTH_OPTION = "@agmux-statusline-width";
const CHIPS = "@agmux-chips";
const CHIPS_REF = /#\{E:@agmux-chips\}/g;

const FIELDS = [
  WIDTH_OPTION, "status-right", "status-right-length", "status-left", "status-left-length", "status-format[1]",
] as const;
const SEP = "\x1f";

export async function readTmuxWidth(capture: Capture): Promise<number | undefined> {
  try {
    const fmt = FIELDS.map((f) => `#{${f}}`).join(SEP);
    const v = (await capture("tmux", ["display-message", "-p", fmt])).replace(/\n$/, "").split(SEP);
    const opt = (f: (typeof FIELDS)[number]) => v[FIELDS.indexOf(f)] ?? "";

    const override = Number(opt(WIDTH_OPTION));
    if (Number.isInteger(override) && override > 0) return override;

    const widths = (await capture("tmux", ["list-clients", "-F", "#{client_width}"]))
      .split("\n").map(Number).filter((n) => n > 0);
    if (widths.length === 0) return undefined;
    const client = Math.min(...widths);

    const sides: [string, number][] = [
      [opt("status-right"), Number(opt("status-right-length")) || client],
      [opt("status-left"), Number(opt("status-left-length")) || client],
      [opt("status-format[1]"), client],
    ];
    const side = sides.find(([f]) => f.includes(CHIPS));
    if (!side) return undefined;
    return Math.max(0, Math.min(side[1], client) - await restWidth(side[0], capture));
  } catch {
    return undefined;
  }
}

// What else shares the chips' place, as tmux draws it now.
async function restWidth(format: string, capture: Capture): Promise<number> {
  const rest = format.replace(CHIPS_REF, "");
  if (!rest.includes("#")) return statusWidth(rest);
  return statusWidth((await capture("tmux", ["display-message", "-p", rest])).replace(/\n$/, ""));
}
