// Mac-side placement of a live remote (sandbox) session: dedup of an already
// open window, then inline / new pane / new window / new session / new
// terminal. Every placement runs the same local pane process (remote-client.ts),
// which tags its pane so the dedup below can find it again.
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
  AGMUX_CONFIG_SUBPATH, isShellSafeId, stripControls, tmuxSocketArgs,
  type HostRow, type RemoteAttachMode, type SessionRow, type TransportSpec,
} from "@agmux/protocol";
import { loadRemotes, transportArgv, type RemoteConfig } from "@agmux/hub";
import { resolvePlacement, type AttachCtx, type AttachRequest, type Handoff } from "@agmux/tui";
import { newSession, newWindow, readCurrentPane, splitPane, switchClient, type PaneCoords } from "./tmux-place.ts";
import { expandTemplate, resumeSessionName, shellQuote, withoutTmuxEnv, type AttachSettings } from "./attach-place.ts";
import { remoteRefusal } from "./remote-guard.ts";

const TITLE_COLS = 40;

function cleanTitle(s: string): string {
  return stripControls(Bun.stripANSI(s)).trim();
}

function capWidth(s: string, cols: number): string {
  if (Bun.stringWidth(s) <= cols) return s;
  let out = "";
  let w = 0;
  for (const { segment } of new Intl.Segmenter().segment(s)) {
    const sw = Bun.stringWidth(segment);
    if (w + sw > cols) break;
    out += segment;
    w += sw;
  }
  return out;
}

// Decision 11: {title} is the session name or the id's first 8 chars, without
// escapes or controls, capped at 40 columns, every `#` doubled (tmux expands
// formats in `-n`). A trailing `;` would end the tmux command: escape it.
export function remoteWindowName(tpl: string, row: Pick<SessionRow, "name" | "session_id">): string {
  const title = capWidth(cleanTitle(row.name ?? "") || cleanTitle(row.session_id.slice(0, 8)), TITLE_COLS).replaceAll("#", "##");
  const name = tpl.split("{title}").join(title);
  return name.endsWith(";") ? `${name.slice(0, -1)}\\;` : name;
}

export const REMOTE_PANES_FMT = "#{session_name}\t#{window_id}\t#{pane_id}\t#{@agmux_session_id}\t#{@agmux_attach_mode}";

// A local pane already showing this session in this mode (its pane options are
// set by the pane process). A failing listing (no server) is no match.
export async function findRemotePane(
  sessionId: string, mode: RemoteAttachMode, listPanes: () => Promise<string>,
): Promise<{ session: string; window: string; pane: string } | null> {
  let out: string;
  try { out = await listPanes(); } catch { return null; }
  for (const line of out.split("\n")) {
    const [session, window, pane, id, m] = line.split("\t");
    if (id === sessionId && m === mode && session && window && pane) return { session, window, pane };
  }
  return null;
}

export function remotePaneCmd(agmuxBin: string, sessionId: string, mode: RemoteAttachMode, detachKey: string): string[] {
  return [agmuxBin, "attach", sessionId, "--remote-client", "--mode", mode, "--detach-key", detachKey];
}

// Closed remote session: what to run by hand to resume it in the sandbox (spec §4.7).
export function manualResumeCommand(spec: TransportSpec, sandboxAgmuxBin: string, sessionId: string): string {
  return stripControls(transportArgv(spec, [sandboxAgmuxBin, "attach", sessionId], { tty: true }).map(shellQuote).join(" "));
}

export function defaultRemotes(): RemoteConfig[] {
  return loadRemotes(path.join(os.homedir(), AGMUX_CONFIG_SUBPATH));
}

// The resume refusal for a remote row, with the manual command when the host's
// transport is known. The sandbox agmux is its [[remote]] agmux_bin, else "agmux".
export async function remoteResumeRefusal(
  row: SessionRow, o: { hubUrl: string; fetchImpl: typeof fetch; remotes: () => RemoteConfig[] },
): Promise<string> {
  let manual: string | undefined;
  try {
    const r = await o.fetchImpl(`${o.hubUrl}/hosts`);
    const spec = r.ok ? ((await r.json()) as { hosts: HostRow[] }).hosts.find((h) => h.host === row.host) : undefined;
    if (spec?.transport && isShellSafeId(row.session_id)) {
      let bin = "agmux";
      try { bin = o.remotes().find((c) => c.name === spec.remote)?.agmux_bin ?? "agmux"; } catch { /* broken config */ }
      manual = manualResumeCommand(spec.transport, bin, row.session_id);
    }
  } catch { /* hub unreachable: refuse without the hint */ }
  return remoteRefusal({ ...row, remote: true }, "resume", manual)!;
}

export interface AttachRemoteDeps {
  runTmux: (args: string[]) => Promise<void>;
  listPanes: () => Promise<string>;
  currentPane: () => Promise<PaneCoords | null>;
  splitPane: typeof splitPane;
  newWindow: typeof newWindow;
  newSession: typeof newSession;
  switchClient: (target: string, socket?: string | null) => Promise<void>;
  spawnDetached: (argv: string[], env: Record<string, string | undefined>) => void;
}

export function spawnDetachedDefault(argv: string[], env: Record<string, string | undefined>): void {
  Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"], env }).unref();
}

export const defaultAttachRemoteDeps: AttachRemoteDeps = {
  runTmux: async (args) => { await $`tmux ${args}`.quiet(); },
  listPanes: () => $`tmux list-panes -a -F ${REMOTE_PANES_FMT}`.quiet().text(),
  currentPane: () => readCurrentPane().catch(() => null),
  splitPane, newWindow, newSession, switchClient,
  spawnDetached: spawnDetachedDefault,
};

export async function attachRemote(
  row: SessionRow,
  req: AttachRequest | undefined,
  env: { ctx: AttachCtx; settings: AttachSettings },
  deps: AttachRemoteDeps,
): Promise<Handoff | null> {
  const { ctx, settings } = env;
  const where = resolvePlacement("remote", ctx, req?.placement, { remote: settings.remote.placement });
  // Decision 6: a view needs a local tmux to detach back into; outside it, full.
  const mode = req?.mode ?? (ctx.inTmux ? settings.remote.mode : "full");
  const id = row.session_id;
  if (!isShellSafeId(id)) throw new Error("attach: invalid session id");
  // Placed elsewhere: in a popup the empty handoff closes the popup onto it.
  const opened = (): Handoff | null => (ctx.popup ? { argv: [] } : null);

  if (ctx.inTmux) {
    const found = await findRemotePane(id, mode, deps.listPanes);
    if (found) {
      await deps.runTmux(["switch-client", "-t", `${found.session}:${found.window}`]);
      await deps.runTmux(["select-pane", "-t", found.pane]);
      return opened();
    }
  }

  const cmd = remotePaneCmd(settings.agmuxBin, id, mode, settings.remote.detachKey);
  if (where === "inline") return { argv: cmd };
  if (where === "peek") throw new Error("peek: planned");
  if (where === "new-tab" || where === "new-terminal") {
    const tpl = where === "new-tab" ? settings.terminal.newTab : settings.terminal.newWindow;
    if (!tpl) throw new Error(`${where}: not configured`);
    // The new terminal is outside tmux: the inline attach there runs the pane process.
    deps.spawnDetached(
      expandTemplate(tpl, [settings.agmuxBin, "attach", id, "--placement", "inline", "--mode", mode]), withoutTmuxEnv(process.env));
    return opened();
  }

  const here = await deps.currentPane();
  if (!here) throw new Error(`${where}: cannot read the current tmux pane`);
  const socket = here.socket;
  // A new pane lives in the caller's window: leave that window's name alone.
  if (where === "new-pane") {
    await deps.splitPane({ targetPane: here.pane, cmd, env: {}, detach: false, socket });
    return opened();
  }
  const windowName = remoteWindowName(settings.remote.windowName, row);
  const coords = where === "new-session"
    ? await deps.newSession({ sessionName: resumeSessionName(id), windowName, cmd, env: {}, socket })
    : await deps.newWindow({ sessionName: here.session, windowName, cmd, env: {}, detach: false, socket });
  // The remote tmux client sets its own titles; keep the agmux name.
  await deps.runTmux([...tmuxSocketArgs(socket), "set-option", "-w", "-t", coords.window, "automatic-rename", "off"]);
  if (where === "new-session") await deps.switchClient(`${coords.session}:${coords.window}`, socket);
  return opened();
}
