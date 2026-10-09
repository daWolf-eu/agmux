// Pure argv builders for `agmux attach --placement` and the dash attach popup
// (docs/superpowers/specs/2026-10-09-dash-attach-popup-design.md). The tmux
// placement itself runs in dash-actions.ts.
import { loadAttachConfig, type AttachConfig } from "@agmux/wrapper";
import type { AttachCtx, AttachDefaults } from "@agmux/tui";

export interface AttachSettings {
  defaults: AttachDefaults;
  terminal: { newWindow?: string[]; newTab?: string[] };
  agmuxBin: string; // absolute when known: a new terminal may not have agmux on PATH
}

export function attachSettingsFrom(cfg: AttachConfig, agmuxBin: string): AttachSettings {
  return {
    defaults: { live: cfg.live, closed: cfg.closed },
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

// "new session" for a resumed agent: a plain one-window session named after it.
export function resumeSessionName(sessionId: string): string {
  return `agmux-${sessionId.slice(0, 8)}`;
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
