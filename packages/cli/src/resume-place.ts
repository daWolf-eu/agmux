import {
  AGMUX_HUB_URL_ENV, AGMUX_SESSION_ID_ENV, AGMUX_PROFILE_ENV, AGMUX_TMUX_SESSION_ENV,
} from "@agmux/protocol";
import type { Handoff } from "@agmux/tui";
import type { RelaunchSpec } from "./relaunch.ts";
import { newWindow, newSession, hasSession, switchClient } from "./tmux-place.ts";

// The agmux env keys a relaunched window must carry explicitly via tmux `-e`. A
// new tmux window inherits only the tmux SERVER env, so agmux-specific vars
// (esp. the hub URL and session id) must be forwarded, not assumed inherited.
// Unlike the wrapper's outside-tmux re-exec (which forwards the full ambient env
// because it IS the launch), a resume restores agent config env from the session
// row via AGMUX_INLINE_PROFILE, so only the agmux control vars need forwarding.
const RELAUNCH_ENV_KEYS = [
  "AGMUX_INLINE_PROFILE",
  AGMUX_HUB_URL_ENV,
  AGMUX_SESSION_ID_ENV,
  AGMUX_TMUX_SESSION_ENV,
  AGMUX_PROFILE_ENV,
  "AGMUX_BIN",
] as const;

export function relaunchEnv(specEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of RELAUNCH_ENV_KEYS) {
    const v = specEnv[k];
    if (v) out[k] = v;
  }
  return out;
}

// Placement deps for resume — injectable so the tmux dance is unit-testable.
export interface ResumePlacementDeps {
  hasSession: (name: string) => Promise<boolean>;
  newWindow: typeof newWindow;
  newSession: typeof newSession;
  switchClient: (target: string, socket?: string | null) => Promise<void>;
}

export const defaultPlacementDeps: ResumePlacementDeps = { hasSession, newWindow, newSession, switchClient };

// Resume a closed agent into the given session (normally the caller's own).
// If that session exists, add a new window; if not (invoked outside tmux, or the
// session vanished), create the session with the same name and the agent as its
// first window. Then move the client onto the new window. Returns the exit
// sentinel so a popup closes onto the freshly switched-to agent.
export async function resumeIntoSession(
  spec: RelaunchSpec,
  targetSession: string,
  label: string,
  deps: ResumePlacementDeps = defaultPlacementDeps,
  socket: string | null = null,
): Promise<Handoff> {
  const windowName = `agmux:${label}`;
  const cmd = spec.wrapArgv;
  const env = relaunchEnv(spec.env);
  const coords = (await deps.hasSession(targetSession))
    ? await deps.newWindow({ sessionName: targetSession, windowName, cmd, env, detach: true, socket })
    : await deps.newSession({ sessionName: targetSession, windowName, cmd, env, socket });
  await deps.switchClient(`${coords.session}:${coords.window}`, socket);
  return { argv: [] };
}
