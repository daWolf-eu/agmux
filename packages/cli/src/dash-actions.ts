import { $ } from "bun";
import { tmuxSocketArgs, type SessionRow } from "@agmux/protocol";
import { attachKind, resolvePlacement, type Actions, type AttachRequest, type Handoff } from "@agmux/tui";
import { createDefaultRegistry } from "@agmux/adapters";
import { buildAttachCommands, type AttachCoords } from "./attach.ts";
import { buildRelaunchSpec } from "./relaunch.ts";
import { loadProfileEnv } from "./profile-env.ts";
import { readCurrentPane, hasSession, splitPane, type PaneCoords } from "./tmux-place.ts";
import { resumeIntoSession, defaultPlacementDeps, relaunchEnv, type ResumePlacementDeps } from "./resume-place.ts";
import { copyToClipboard } from "./clipboard.ts";
import { postSeen } from "./seen.ts";
import {
  DEFAULT_ATTACH_SETTINGS, attachCtxFor, buildViewClientArgv, buildGroupedSessionCommands,
  expandTemplate, groupedSessionName, nestedTmuxArgv, viewSessionName, type AttachSettings,
} from "./attach-place.ts";

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
  // The caller's tmux pane (default: tmux display-message); null outside tmux.
  currentPane?: () => Promise<PaneCoords | null>;
  // Launch a [terminal] template without waiting for it.
  spawnDetached?: (argv: string[], env: Record<string, string | undefined>) => void;
  // Is this window (id) part of that session? Grouped sessions share windows.
  windowInSession?: (session: string, window: string, socket: string | null) => Promise<boolean>;
  // Resume placement (new window / new session); default: real tmux.
  placement?: ResumePlacementDeps;
  splitPane?: typeof splitPane;
  now?: () => number;
}

const defaultActionDeps: ActionDeps = {
  runTmux: async (args) => { await $`tmux ${args}`.quiet(); },
  sessionExists: hasSession,
};

function spawnDetachedDefault(argv: string[], env: Record<string, string | undefined>): void {
  Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"], env }).unref();
}

async function windowInSessionDefault(session: string, window: string, socket: string | null): Promise<boolean> {
  try {
    const out = await $`tmux ${tmuxSocketArgs(socket)} list-windows -t ${session} -F ${"#{window_id}"}`.quiet().text();
    return out.split("\n").includes(window);
  } catch {
    return false;
  }
}

// A null socket means "the default server" (agmux run outside tmux records null),
// which from inside tmux is indistinguishable from the caller's own server.
function sameServer(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

// A new terminal must not look like it runs inside the dash's tmux client, or
// `agmux attach` there would switch the dash's client instead of attaching.
function withoutTmuxEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = env;
  return rest;
}

export function makeActions(
  hubUrl: string,
  wrapBin: string,
  popup = false,
  deps: ActionDeps = defaultActionDeps,
  settings: AttachSettings = DEFAULT_ATTACH_SETTINGS,
): Actions {
  const inTmux = !!process.env.TMUX;
  const sessionExists = deps.sessionExists ?? hasSession;
  const currentPane = deps.currentPane ?? (() => readCurrentPane().catch(() => null));
  const spawnDetached = deps.spawnDetached ?? spawnDetachedDefault;
  const windowInSession = deps.windowInSession ?? windowInSessionDefault;
  const placement = deps.placement ?? defaultPlacementDeps;
  const split = deps.splitPane ?? splitPane;
  const now = deps.now ?? Date.now;
  const ctx = attachCtxFor(settings, process.env, popup);
  // Opened somewhere else: in a popup the empty handoff closes the popup onto
  // it; in an inline dash the dash stays (null).
  const opened = (): Handoff | null => (popup ? { argv: [] } : null);

  function openTerminal(where: "new-tab" | "new-terminal", row: SessionRow): Handoff | null {
    const tpl = where === "new-tab" ? settings.terminal.newTab : settings.terminal.newWindow;
    if (!tpl) throw new Error(`${where}: not configured`);
    // The new terminal runs outside tmux, so a plain `agmux attach` opens it inline there.
    spawnDetached(expandTemplate(tpl, [settings.agmuxBin, "attach", row.session_id]), withoutTmuxEnv(process.env));
    return opened();
  }

  async function resume(row: SessionRow, req?: AttachRequest): Promise<Handoff | null> {
    const where = resolvePlacement("closed", ctx, req?.placement, settings.defaults);
    if (where === "new-tab" || where === "new-terminal") return openTerminal(where, row);
    const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
    const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
    const spec = buildRelaunchSpec(session, {
      hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
      turnCount: usage?.turn_count ?? 0, loadProfileEnv,
    });
    // inline: hand the terminal (or the dash's own pane) to the relaunched agent.
    if (where === "inline") return { argv: spec.wrapArgv, env: spec.env };
    const here = await currentPane();
    const socket = here?.socket ?? null;
    const label = row.session_id.slice(0, 8);
    if (where === "new-pane") {
      if (!here) throw new Error("new pane: cannot read the current tmux pane");
      await split({ targetPane: here.pane, cmd: spec.wrapArgv, env: relaunchEnv(spec.env), detach: false, socket });
      return opened();
    }
    if (where === "new-session") {
      const coords = await placement.newSession({
        sessionName: groupedSessionName(row.session_id), windowName: `agmux:${label}`,
        cmd: spec.wrapArgv, env: relaunchEnv(spec.env), socket,
      });
      await placement.switchClient(`${coords.session}:${coords.window}`, socket);
      return opened();
    }
    // new-window: a new window of the caller's session (the pre-popup default).
    const target = here?.session ?? session.tmux_session ?? "agmux";
    const h = await resumeIntoSession(spec, target, label, placement, socket);
    return popup ? h : null;
  }

  return {
    async attach(row: SessionRow, req?: AttachRequest): Promise<Handoff | null> {
      // No tmux target to focus → nothing to attach to (unchanged no-op).
      if (attachKind(row) !== "live") return null;
      // Status is only a lagging approximation of tmux reality: a LIVE row whose
      // tmux session is gone (e.g. pinned live by pid reuse, spec §8) would make
      // a doomed attach that errors out — resume it instead of failing.
      if (!(await sessionExists(row.tmux_session!, row.tmux_socket))) return resume(row, req);
      const where = resolvePlacement("live", ctx, req?.placement, settings.defaults);
      const coords: AttachCoords = {
        tmux_session: row.tmux_session!, tmux_window: row.tmux_window!, tmux_pane: row.tmux_pane, tmux_socket: row.tmux_socket,
      };
      if (where === "new-tab" || where === "new-terminal") return openTerminal(where, row);
      if (where === "new-session") {
        // switch-client can't move a client to another server, and a session
        // created there would never be reaped.
        const here = await currentPane();
        if (here && !sameServer(here.socket, row.tmux_socket)) throw new Error("new session: agent is on another tmux server");
        const name = groupedSessionName(row.session_id);
        const exists = await sessionExists(name, row.tmux_socket);
        for (const args of buildGroupedSessionCommands(coords, name, exists)) await deps.runTmux(args);
        return opened();
      }
      if (where === "new-pane" || where === "new-window") {
        const here = await currentPane();
        // A view of a session that already holds the agent's window (the caller's
        // own, or one grouped with it) would show itself — go there inline instead.
        const alreadyHere = !!here && sameServer(here.socket, row.tmux_socket)
          && await windowInSession(here.session, row.tmux_window!, here.socket);
        if (here && !alreadyHere) {
          const view = nestedTmuxArgv(buildViewClientArgv(coords, viewSessionName(row.session_id, now()), settings.viewDetachKey));
          const hs = tmuxSocketArgs(here.socket);
          await deps.runTmux(where === "new-pane"
            ? [...hs, "split-window", "-t", here.pane, "--", ...view]
            : [...hs, "new-window", "-t", `${here.session}:`, "-n", `view:${row.session_id.slice(0, 8)}`, "--", ...view]);
          return opened();
        }
      }
      // inline (today's behaviour)
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
    async copy(text: string): Promise<void> {
      await copyToClipboard(text);
    },
    async markSeen(row: SessionRow): Promise<void> {
      // One-way by design: there is no "mark unread" event in the protocol —
      // session.seen only carries a source (attach | dismiss | focus), and seen_ts is
      // monotonic (MAX upsert, see packages/store/src/project.ts) so that a
      // queued event landing after a hub restart can't un-see a newer
      // acknowledgement. A session becomes `done` again only via a fresh
      // attention event (turn.ended / input.required / session.ended); this
      // action can only ever move a row from done to idle. Do not add a
      // toggle here without a new event kind and projection rule.
      await postSeen(row.session_id, "dismiss", {
        hubUrl, host: row.host,
        fetchImpl: fetch, now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
      });
    },
  };
}
