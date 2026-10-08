import { parseChipToken } from "@agmux/tui";

export type ClickButton = "left" | "right";

export interface StatuslineClickDeps {
  attach: (idOrPrefix: string) => Promise<number>;
  seen: (opts: { idOrPrefix?: string }) => Promise<number>;
  cycleShow: (step: 1 | -1) => Promise<number>;
}

// A click on a status-line chip, as agmux.tmux forwards it: the button and the
// chip's #{mouse_status_range} token.
//   left  on a chip → switch to its pane (attach also marks it seen)
//   right on a chip → mark it seen, stay where you are
//   left  on ▽      → next show mode (SHOW_CYCLE), right → previous
// A token that isn't ours is a no-op: agmux.tmux already filters, this is the
// second line of defence.
export async function statuslineClick(
  button: ClickButton, token: string, deps: StatuslineClickDeps,
): Promise<number> {
  const target = parseChipToken(token);
  if (!target) return 0;
  if (target.kind === "filter") return deps.cycleShow(button === "left" ? 1 : -1);
  return button === "left" ? deps.attach(target.prefix) : deps.seen({ idOrPrefix: target.prefix });
}
