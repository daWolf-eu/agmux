import { $ } from "bun";
import type { SessionRow } from "@agmux/protocol";
import type { Actions, Handoff } from "@agmux/tui";
import { createDefaultRegistry } from "@agmux/adapters";
import { LIVE_STATUSES } from "@agmux/protocol";
import { buildAttachCommands, type AttachCoords } from "./attach.ts";
import { buildRelaunchSpec } from "./relaunch.ts";
import { loadProfileEnv } from "./profile-env.ts";
import { readCurrentPane, hasSession } from "./tmux-place.ts";
import { resumeIntoSession, defaultPlacementDeps } from "./resume-place.ts";

// Resume-placement helpers live in ./resume-place.ts so both dash and the plain
// `attach` command can share them without an import cycle (dash-actions already
// depends on attach.ts for buildAttachCommands). Re-exported for callers/tests.
export { relaunchEnv, resumeIntoSession, defaultPlacementDeps, type ResumePlacementDeps } from "./resume-place.ts";

// Popup-mode attach: retarget the parent client inline, then exit dash (empty
// argv) so the `display-popup -E` closes and reveals the agent's window.
export async function attachInPopup(
  coords: AttachCoords,
  runTmux: (args: string[]) => Promise<void>,
): Promise<Handoff> {
  for (const args of buildAttachCommands(coords, true)) await runTmux(args);
  return { argv: [] };
}

export interface ActionDeps {
  runTmux: (args: string[]) => Promise<void>;
  // Probe whether a tmux session still exists — injectable for tests. Defaults
  // to the real tmux `has-session`. Used to catch stale-live rows (see attach).
  sessionExists?: (name: string, socket: string | null) => Promise<boolean>;
}

const defaultActionDeps: ActionDeps = {
  runTmux: async (args) => { await $`tmux ${args}`.quiet(); },
  sessionExists: hasSession,
};

export function makeActions(
  hubUrl: string,
  wrapBin: string,
  popup = false,
  deps: ActionDeps = defaultActionDeps,
): Actions {
  const inTmux = !!process.env.TMUX;
  const sessionExists = deps.sessionExists ?? hasSession;

  async function resume(row: SessionRow): Promise<Handoff | null> {
    const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
    const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
    const spec = buildRelaunchSpec(session, {
      hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
      turnCount: usage?.turn_count ?? 0, loadProfileEnv,
    });
    // Outside tmux: no client to switch — hand the terminal to the relaunched agent.
    if (!inTmux) return { argv: spec.wrapArgv, env: spec.env };
    // In tmux (popup or inline): place the agent in a new window of the caller's
    // session and switch the client onto it.
    const here = await readCurrentPane().catch(() => null);
    const target = here?.session ?? session.tmux_session ?? "agmux";
    const socket = here?.socket ?? null;
    const h = await resumeIntoSession(spec, target, row.session_id.slice(0, 8), defaultPlacementDeps, socket);
    // popup: exit sentinel closes the popup onto the agent. inline tmux: client
    // already switched, keep the dash alive (return null).
    return popup ? h : null;
  }

  return {
    // In tmux → switch-client inline (TUI stays alive), return null.
    // Not in tmux → return a Handoff so the entry hands the terminal to a
    // blocking attach-session after ink unmounts.
    async attach(row: SessionRow): Promise<Handoff | null> {
      // No tmux target to focus → nothing to attach to (unchanged no-op).
      if (!LIVE_STATUSES.includes(row.status) || !row.tmux_session || !row.tmux_window) return null;
      // Status is only a lagging approximation of tmux reality: a LIVE row whose
      // tmux session is gone (e.g. pinned live by pid reuse, spec §8) would make
      // a doomed attach that errors out — resume it instead of failing.
      if (!(await sessionExists(row.tmux_session, row.tmux_socket))) return resume(row);
      const coords: AttachCoords = {
        tmux_session: row.tmux_session, tmux_window: row.tmux_window, tmux_pane: row.tmux_pane, tmux_socket: row.tmux_socket,
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
    resume,
  };
}
