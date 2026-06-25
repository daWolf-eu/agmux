import { $ } from "bun";
import type { SessionRow } from "@agmux/protocol";
import {
  LIVE_STATUSES,
  AGMUX_HUB_URL_ENV, AGMUX_SESSION_ID_ENV, AGMUX_PROFILE_ENV, AGMUX_TMUX_SESSION_ENV,
} from "@agmux/protocol";
import type { Actions, Handoff } from "@agmux/tui";
import { createDefaultRegistry } from "@agmux/adapters";
import { buildAttachCommands, type AttachCoords } from "./attach.ts";
import { buildRelaunchSpec, type RelaunchSpec } from "./relaunch.ts";
import { newWindow, newSession, hasSession, switchClient, readCurrentPane } from "./tmux-place.ts";

// The agmux env keys a relaunched window must carry explicitly via tmux `-e`. A
// new tmux window inherits only the tmux SERVER env, so agmux-specific vars
// (esp. the hub URL and session id) must be forwarded, not assumed inherited.
// Mirrors the allowlist in packages/wrapper/src/index.ts.
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

// Popup-mode attach: retarget the parent client inline, then exit dash (empty
// argv) so the `display-popup -E` closes and reveals the agent's window.
export async function attachInPopup(
  coords: AttachCoords,
  runTmux: (args: string[]) => Promise<void>,
): Promise<Handoff> {
  for (const args of buildAttachCommands(coords, true)) await runTmux(args);
  return { argv: [] };
}

// Placement deps for resume — injectable so the tmux dance is unit-testable.
export interface ResumePlacementDeps {
  hasSession: (name: string) => Promise<boolean>;
  newWindow: typeof newWindow;
  newSession: typeof newSession;
  switchClient: (target: string) => Promise<void>;
}

const defaultPlacementDeps: ResumePlacementDeps = { hasSession, newWindow, newSession, switchClient };

// Resume a closed agent into the session dash runs in (the caller's session).
// If that session exists, add a new window; if not (dash launched outside tmux),
// create the session with the same name and the agent as its first window. Then
// move the client onto the new window. Returns the exit sentinel so a popup closes
// onto the freshly switched-to agent.
export async function resumeIntoSession(
  spec: RelaunchSpec,
  targetSession: string,
  label: string,
  deps: ResumePlacementDeps = defaultPlacementDeps,
): Promise<Handoff> {
  const windowName = `agmux:${label}`;
  const cmd = spec.wrapArgv;
  const env = relaunchEnv(spec.env);
  const coords = (await deps.hasSession(targetSession))
    ? await deps.newWindow({ sessionName: targetSession, windowName, cmd, env, detach: true })
    : await deps.newSession({ sessionName: targetSession, windowName, cmd, env });
  await deps.switchClient(`${coords.session}:${coords.window}`);
  return { argv: [] };
}

export interface ActionDeps {
  runTmux: (args: string[]) => Promise<void>;
}

const defaultActionDeps: ActionDeps = {
  runTmux: async (args) => { await $`tmux ${args}`.quiet(); },
};

export function makeActions(
  hubUrl: string,
  wrapBin: string,
  popup = false,
  deps: ActionDeps = defaultActionDeps,
): Actions {
  const inTmux = !!process.env.TMUX;
  return {
    // In tmux → switch-client inline (TUI stays alive), return null.
    // Not in tmux → return a Handoff so the entry hands the terminal to a
    // blocking attach-session after ink unmounts.
    async attach(row: SessionRow): Promise<Handoff | null> {
      if (!LIVE_STATUSES.includes(row.status) || !row.tmux_session || !row.tmux_window) return null;
      const coords: AttachCoords = {
        tmux_session: row.tmux_session, tmux_window: row.tmux_window, tmux_pane: row.tmux_pane,
      };
      if (popup) return attachInPopup(coords, deps.runTmux);
      const cmds = buildAttachCommands(coords, inTmux);
      if (inTmux) { for (const args of cmds) await deps.runTmux(args); return null; }
      return { argv: ["tmux", ...cmds[0]!] };
    },
    async kill(row: SessionRow): Promise<void> {
      if (!row.pid) return;
      try { process.kill(row.pid, "SIGTERM"); } catch { /* already gone */ }
    },
    async resume(row: SessionRow): Promise<Handoff | null> {
      const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
      const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
      const spec = buildRelaunchSpec(session, {
        hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
        turnCount: usage?.turn_count ?? 0,
      });
      // Outside tmux: no client to switch — hand the terminal to the relaunched agent.
      if (!inTmux) return { argv: spec.wrapArgv, env: spec.env };
      // In tmux (popup or inline): place the agent in a new window of the caller's
      // session and switch the client onto it.
      const coords = await readCurrentPane().catch(() => null);
      const target = coords?.session ?? session.tmux_session ?? "agmux";
      const h = await resumeIntoSession(spec, target, row.session_id.slice(0, 8));
      // popup: exit sentinel closes the popup onto the agent. inline tmux: client
      // already switched, keep the dash alive (return null).
      return popup ? h : null;
    },
  };
}
