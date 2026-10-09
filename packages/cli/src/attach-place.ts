// Pure argv builders for `agmux attach --placement` and the dash attach popup
// (docs/superpowers/specs/2026-10-09-dash-attach-popup-design.md). The tmux
// dance itself runs in dash-actions.ts.
import { tmuxSocketArgs } from "@agmux/protocol";
import { loadAttachConfig, type AttachConfig } from "@agmux/wrapper";
import type { AttachCtx, AttachDefaults } from "@agmux/tui";
import type { AttachCoords } from "./attach.ts";

export const DEFAULT_VIEW_DETACH_KEY = "M-d";

export interface AttachSettings {
  defaults: AttachDefaults;
  viewDetachKey: string;
  terminal: { newWindow?: string[]; newTab?: string[] };
  agmuxBin: string; // absolute when known: a new terminal may not have agmux on PATH
}

export function attachSettingsFrom(cfg: AttachConfig, agmuxBin: string): AttachSettings {
  return {
    defaults: { live: cfg.live, closed: cfg.closed },
    viewDetachKey: cfg.viewDetachKey ?? DEFAULT_VIEW_DETACH_KEY,
    terminal: cfg.terminal,
    agmuxBin,
  };
}

export const DEFAULT_ATTACH_SETTINGS: AttachSettings = attachSettingsFrom({ terminal: {} }, "agmux");

// [attach]/[terminal] from config.toml + the agmux binary a new terminal should run.
export function loadAttachSettings(configPath: string): AttachSettings {
  const bin = process.env.AGMUX_BIN ?? Bun.which("agmux") ?? "agmux";
  return attachSettingsFrom(loadAttachConfig(configPath), bin);
}

export function attachCtxFor(s: AttachSettings, env: Record<string, string | undefined>, popup: boolean): AttachCtx {
  return { inTmux: !!env.TMUX, popup, terminalWindow: !!s.terminal.newWindow, terminalTab: !!s.terminal.newTab };
}

// One grouped session per agent for "new session"; re-opening switches to it.
export function groupedSessionName(sessionId: string): string {
  return `agmux-${sessionId.slice(0, 8)}`;
}

// View sessions are per pane, so several views of one agent can coexist.
export function viewSessionName(sessionId: string, now: number): string {
  return `agmux-view-${sessionId.slice(0, 8)}-${now.toString(36)}`;
}

// The command a new pane/window runs to show a live agent: a second client
// (TMUX unset, so tmux allows it) on a throw-away session grouped with the
// agent's. Prefix and status are off and the key table holds one detach key,
// so the outer tmux keeps every other key. destroy-unattached reaps the view
// when its pane closes; the agent's own session is never touched.
export function buildViewClientArgv(c: AttachCoords, view: string, detachKey: string): string[] {
  const argv = [
    "env", "-u", "TMUX", "tmux", ...tmuxSocketArgs(c.tmux_socket),
    "new-session", "-t", c.tmux_session, "-s", view,
    ";", "set-option", "-t", view, "destroy-unattached", "on",
    ";", "set-option", "-t", view, "status", "off",
    ";", "set-option", "-t", view, "prefix", "None",
    ";", "set-option", "-t", view, "prefix2", "None",
    ";", "bind-key", "-T", "agmux-view", detachKey, "detach-client",
    ";", "set-option", "-t", view, "key-table", "agmux-view",
    ";", "select-window", "-t", `${view}:${c.tmux_window}`,
  ];
  if (c.tmux_pane) argv.push(";", "select-pane", "-t", c.tmux_pane);
  return argv;
}

// A command embedded in another tmux command (`new-window -- …`,
// `split-window -- …`) is parsed by that outer tmux first, and a bare ";" there
// ends the outer command. "\;" reaches the inner tmux as a literal ";".
export function nestedTmuxArgv(argv: string[]): string[] {
  return argv.map((a) => (a === ";" ? "\\;" : a));
}

// "new session" for a live agent: no nesting — a grouped session on the agent's
// server, and the caller's client switches to it. destroy-unattached is set only
// after the switch, so tmux can't reap the session before anyone is attached.
export function buildGroupedSessionCommands(c: AttachCoords, name: string, exists: boolean): string[][] {
  const sock = tmuxSocketArgs(c.tmux_socket);
  const cmds: string[][] = [];
  if (!exists) cmds.push([...sock, "new-session", "-d", "-t", c.tmux_session, "-s", name]);
  cmds.push([...sock, "switch-client", "-t", name]);
  if (!exists) cmds.push([...sock, "set-option", "-t", name, "destroy-unattached", "on"]);
  cmds.push([...sock, "select-window", "-t", `${name}:${c.tmux_window}`]);
  if (c.tmux_pane) cmds.push([...sock, "select-pane", "-t", c.tmux_pane]);
  return cmds;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// [terminal] templates: an element that IS "{cmd}" becomes the command's argv;
// "{cmd}" inside a larger string becomes the shell-quoted command line.
export function expandTemplate(tpl: string[], cmd: string[]): string[] {
  const line = cmd.map(shellQuote).join(" ");
  return tpl.flatMap((el) => (el === "{cmd}" ? cmd : [el.split("{cmd}").join(line)]));
}
