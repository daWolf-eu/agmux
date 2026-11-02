import { detectMux, type MuxKind } from "@agmux/protocol";
import { defaultRexExec, type RexExec } from "@agmux/wrapper";
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

export function placementOps(
  env: Record<string, string | undefined>,
  popup = false,
  exec: RexExec = defaultRexExec,
): PlacementOps {
  if (detectMux(env) === "rex") {
    const server = env.REX_SERVER || null;
    const currentPane = () => rexCurrentPane(env, popup, exec);
    return {
      kind: "rex",
      currentPane,
      splitPane: (a) => rexSplitPane({ ...a, session: a.session ?? env.REX_SESSION }, exec),
      hasSession: (name) => rexHasSession(name, server, exec),
      newWindow: (a) => rexNewWindow({ ...a, socket: a.socket ?? server }, exec),
      newSession: (a) => rexNewSession({ ...a, socket: a.socket ?? server }, exec),
      switchClient: async (target, socket) => {
        const here = await currentPane();
        await rexSwitchClient(target, socket ?? server, here ? { block: here.pane, server: here.socket } : null, exec);
      },
    };
  }
  return { kind: "tmux", currentPane: readCurrentPane, splitPane, hasSession, newWindow, newSession, switchClient };
}
