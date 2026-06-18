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
import { newWindow, readCurrentPane } from "./tmux-place.ts";

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

// Popup-mode resume: relaunch the agent in a NEW tmux window (non-detached, so the
// parent client switches to it), forwarding only the agmux env keys explicitly,
// then exit dash (empty argv) so the popup closes onto the freshly relaunched agent.
export async function resumeIntoNewWindow(
  spec: RelaunchSpec,
  sessionName: string,
  label: string,
  newWindowFn: typeof newWindow = newWindow,
): Promise<Handoff> {
  await newWindowFn({
    sessionName,
    windowName: `agmux:${label}`,
    cmd: spec.wrapArgv,
    env: relaunchEnv(spec.env),
    detach: false,
  });
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
    async resume(row: SessionRow): Promise<Handoff> {
      const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
      const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
      const spec = buildRelaunchSpec(session, {
        hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
        turnCount: usage?.turn_count ?? 0,
      });
      if (!popup) return { argv: spec.wrapArgv, env: spec.env };
      const coords = await readCurrentPane().catch(() => null);
      const sessionName = coords?.session ?? session.tmux_session ?? "agmux";
      return resumeIntoNewWindow(spec, sessionName, row.session_id.slice(0, 8));
    },
  };
}
