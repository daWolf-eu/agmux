import { detectMux, type MuxKind } from "@agmux/protocol";
import {
  readCurrentPane, splitPane, newWindow, newSession, hasSession, switchClient, type PaneCoords,
} from "./tmux-place.ts";
import {
  rexCurrentPane, rexSplitPane, rexNewWindow, rexNewSession, rexHasSession, rexSwitchClient,
} from "./rex-place.ts";
import type { ResumePlacementDeps } from "./resume-place.ts";

// The placement operations for the multiplexer the caller is in: Rex inside
// Rex, otherwise tmux exactly as before.
export interface PlacementOps extends ResumePlacementDeps {
  kind: MuxKind;
  currentPane: () => Promise<PaneCoords | null>;
  splitPane: typeof splitPane;
}

export function placementOps(env: Record<string, string | undefined>, popup = false): PlacementOps {
  if (detectMux(env) === "rex") {
    const server = env.REX_SERVER || null;
    return {
      kind: "rex",
      currentPane: () => rexCurrentPane(env, popup),
      splitPane: (a) => rexSplitPane({ ...a, session: a.session ?? env.REX_SESSION }),
      hasSession: (name) => rexHasSession(name, server),
      newWindow: (a) => rexNewWindow({ ...a, socket: a.socket ?? server }),
      newSession: (a) => rexNewSession({ ...a, socket: a.socket ?? server }),
      switchClient: (target, socket) => rexSwitchClient(target, socket ?? server),
    };
  }
  return { kind: "tmux", currentPane: readCurrentPane, splitPane, hasSession, newWindow, newSession, switchClient };
}
