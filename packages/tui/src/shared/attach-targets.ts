import {
  ATTACH_PLACEMENTS, LIVE_STATUSES, TERMINAL_STATUSES, type AttachPlacement, type SessionRow,
} from "@agmux/protocol";

// What a session offers to open: a live tmux pane, a closed session (resume),
// or a live session with no tmux coords (nothing to open).
export type AttachKind = "live" | "closed" | "none";

export function attachKind(row: SessionRow): AttachKind {
  if (TERMINAL_STATUSES.includes(row.status)) return "closed";
  if (LIVE_STATUSES.includes(row.status) && row.tmux_session && row.tmux_window) return "live";
  return "none";
}

// The caller's situation. Computed once by the cli (attachCtxFor) and shared by
// the popup (to dim targets) and the actions (to validate) so both agree.
export interface AttachCtx {
  inTmux: boolean;         // running inside a tmux client
  popup: boolean;          // the dash runs in `display-popup -E` (`agmux dash --popup`)
  terminalWindow: boolean; // [terminal] new_window configured
  terminalTab: boolean;    // [terminal] new_tab configured
}

export const NO_ATTACH_CTX: AttachCtx = { inTmux: false, popup: false, terminalWindow: false, terminalTab: false };

export interface AttachTarget {
  placement: AttachPlacement;
  label: string;
  enabled: boolean;
  reason: string; // why it is disabled; "" when enabled
}

export interface AttachDefaults { live?: AttachPlacement; closed?: AttachPlacement }

const LABELS: Record<AttachPlacement, string> = {
  inline: "inline", "new-pane": "new pane", "new-window": "new window", "new-session": "new session",
  peek: "peek", "new-tab": "new tab", "new-terminal": "new terminal window",
};

function reasonFor(p: AttachPlacement, kind: AttachKind, ctx: AttachCtx): string {
  if (kind === "none") return "no tmux pane";
  switch (p) {
    // A resumed agent in the dash's own pane would die with the popup.
    case "inline": return kind === "closed" && ctx.popup ? "in popup" : "";
    // A live agent can't move; opening it elsewhere would need a second view of
    // its window. Switching to where it runs (inline) is the local attach.
    case "new-pane":
    case "new-window":
    case "new-session":
      if (kind === "live") return "already open";
      return ctx.inTmux ? "" : "not in tmux";
    // Phase 1: peek is not built yet; for a resume it can never work.
    case "peek": return kind === "closed" ? "ends with popup" : "planned";
    case "new-tab": return ctx.terminalTab ? "" : "not configured";
    case "new-terminal": return ctx.terminalWindow ? "" : "not configured";
  }
}

// Always all placements, in slot order; unavailable ones keep their slot (yank convention).
export function attachTargets(kind: AttachKind, ctx: AttachCtx): AttachTarget[] {
  return ATTACH_PLACEMENTS.map((placement) => {
    const reason = reasonFor(placement, kind, ctx);
    return { placement, label: LABELS[placement], enabled: reason === "", reason };
  });
}

// ⏎: the configured default when it is possible here, else inline, else a new
// window (closed session in a popup). Without config this is the pre-popup behaviour.
export function defaultPlacement(kind: AttachKind, ctx: AttachCtx, defaults: AttachDefaults = {}): AttachPlacement {
  const want: AttachPlacement = kind === "closed"
    ? defaults.closed ?? (ctx.inTmux ? "new-window" : "inline")
    : defaults.live ?? "inline";
  const targets = attachTargets(kind, ctx);
  const enabled = (p: AttachPlacement) => targets.find((t) => t.placement === p)!.enabled;
  for (const p of [want, "inline", "new-window"] as const) if (enabled(p)) return p;
  return "inline";
}

// An explicit request must be available; no request means the default.
export function resolvePlacement(
  kind: AttachKind, ctx: AttachCtx, req: AttachPlacement | undefined, defaults: AttachDefaults = {},
): AttachPlacement {
  if (req === undefined) return defaultPlacement(kind, ctx, defaults);
  const t = attachTargets(kind, ctx).find((x) => x.placement === req)!;
  if (!t.enabled) throw new Error(`${t.label}: ${t.reason}`);
  return req;
}
