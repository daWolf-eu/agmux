import type { NotifyEvent } from "@agmux/tui";
import type { NotifyConfig } from "./attention-config.ts";
import { resolveNotifier, buildNotifyArgv, type NotifySpec } from "./notifier.ts";

export type RunCmd = (cmd: string, args: string[]) => Promise<number>;

export interface SinkDeps {
  run: RunCmd;
  capture: (cmd: string, args: string[]) => Promise<string>;
  which: (bin: string) => boolean;
  log: (s: string) => void;
}

// tmux knows which pane each attached client has active. It does NOT know whether
// the terminal emulator itself has OS focus — a pane can be "active" behind a
// browser window. So this gates the tmux toast only; the OS notification is
// precisely the signal that should still fire when you have tabbed away.
export async function isPaneVisible(
  paneId: string | null,
  deps: Pick<SinkDeps, "capture">,
): Promise<boolean> {
  if (!paneId) return false;
  try {
    const out = await deps.capture("tmux", ["list-clients", "-F", "#{pane_id}"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean).includes(paneId);
  } catch {
    return false;
  }
}

function describe(ev: NotifyEvent): string {
  const r = ev.row;
  const where = r.tmux_session ? `${r.tmux_session}:${r.tmux_window ?? ""}`.replace(/:$/, "") : r.agent_kind;
  const what =
    ev.trigger === "permission" ? "needs permission" :
    ev.trigger === "prompt" ? "is waiting for input" :
    ev.trigger === "turn_end" ? "finished a turn" : "ended";
  return `${where} ${what}`;
}

// A missing notifier is a static fact about the machine, not per-event news:
// warn about a given configured command once per process, never once per
// event — repeating it on every fired notification would itself be the kind
// of notification storm this pipeline exists to avoid.
const warnedMissingNotifier = new Set<string>();

export async function dispatchNotification(
  ev: NotifyEvent,
  cfg: NotifyConfig,
  deps: SinkDeps,
): Promise<void> {
  const body = describe(ev);

  if (cfg.tmuxMessage && !(cfg.suppressWhenVisible && await isPaneVisible(ev.row.tmux_pane, deps))) {
    // display-message only. A popup freezes pane rendering and discards
    // keystrokes typed while it is open — see the spike in the spec, §2.
    try { await deps.run("tmux", ["display-message", `agmux: ${body}`]); } catch { /* tmux absent */ }
  }

  const kind = resolveNotifier(cfg.command, deps.which);
  if (!kind) {
    if (!warnedMissingNotifier.has(cfg.command)) {
      warnedMissingNotifier.add(cfg.command);
      deps.log(`agmux: no notifier available (configured: ${cfg.command})`);
    }
    return;
  }

  const sound = cfg.sound ? (cfg.sounds[ev.trigger] ?? cfg.soundName) : null;
  const spec: NotifySpec = { title: "agmux", body, sound, attachId: ev.session_id };
  const { cmd, args } = buildNotifyArgv(kind, spec, cfg.command);
  try {
    // Exit code is deliberately ignored: osascript returns 0 whether or not a
    // banner was shown, so it is not evidence of delivery (spec §2).
    await deps.run(cmd, args);
  } catch {
    deps.log(`agmux: notifier ${cmd} failed`);
  }
}
