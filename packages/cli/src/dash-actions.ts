import { $ } from "bun";
import type { SessionRow } from "@agmux/protocol";
import { LIVE_STATUSES } from "@agmux/protocol";
import type { Actions, Handoff } from "@agmux/tui";
import { createDefaultRegistry } from "@agmux/adapters";
import { buildAttachCommands } from "./attach.ts";
import { buildRelaunchSpec } from "./relaunch.ts";

// The env keys a relaunch adds on top of the inherited environment. A new tmux
// window already inherits the parent env, so we only inject these via `-e`.
export function deltaEnv(
  specEnv: Record<string, string>,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(specEnv)) {
    if (baseEnv[k] !== v) out[k] = v;
  }
  return out;
}

export function makeActions(hubUrl: string, wrapBin: string): Actions {
  const inTmux = !!process.env.TMUX;
  return {
    // In tmux → switch-client inline (TUI stays alive), return null.
    // Not in tmux → return a Handoff so the entry hands the terminal to a
    // blocking attach-session after ink unmounts.
    async attach(row: SessionRow): Promise<Handoff | null> {
      if (!LIVE_STATUSES.includes(row.status) || !row.tmux_session || !row.tmux_window) return null;
      const cmds = buildAttachCommands(
        { tmux_session: row.tmux_session, tmux_window: row.tmux_window, tmux_pane: row.tmux_pane },
        inTmux,
      );
      if (inTmux) { for (const args of cmds) await $`tmux ${args}`.quiet(); return null; }
      return { argv: ["tmux", ...cmds[0]!] };
    },
    async kill(row: SessionRow): Promise<void> {
      if (!row.pid) return;
      try { process.kill(row.pid, "SIGTERM"); } catch { /* already gone */ }
    },
    // Resume always hands off: the relaunched wrapper wants the terminal.
    async resume(row: SessionRow): Promise<Handoff> {
      const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
      const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
      const spec = buildRelaunchSpec(session, {
        hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
        turnCount: usage?.turn_count ?? 0,
      });
      return { argv: spec.wrapArgv, env: spec.env };
    },
  };
}
