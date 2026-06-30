import { $ } from "bun";
import type { SessionRow } from "@agmux/protocol";
import { LIVE_STATUSES, tmuxSocketArgs } from "@agmux/protocol";
import { createDefaultRegistry, type Registry } from "@agmux/adapters";
import { buildRelaunchSpec } from "./relaunch.ts";
import { resolvePrefix } from "./id-resolve.ts";
import { loadProfileEnv } from "./profile-env.ts";

export interface AttachOpts { idOrPrefix: string; hubUrl: string; wrapBin: string; registry?: Registry; }

export interface AttachCoords { tmux_session: string; tmux_window: string; tmux_pane: string | null; tmux_socket: string | null; }

// Build the tmux invocation(s) that focus a session's pane.
//   inTmux  → switch the current client's window, then select the pane (two
//             independent commands; switch-client returns immediately).
//   !inTmux → one foreground `attach-session` that also selects window + pane,
//             chained with literal `;` separators (each its own argv element so
//             tmux treats it as a command separator — no shell escaping).
// Pane ids (`%N`) are server-global, so `select-pane -t %N` needs no qualifier.
// Without a stored pane we fall back to window-only (prior behavior).
export function buildAttachCommands(c: AttachCoords, inTmux: boolean): string[][] {
  const winTarget = `${c.tmux_session}:${c.tmux_window}`;
  const sock = tmuxSocketArgs(c.tmux_socket);
  if (inTmux) {
    const cmds: string[][] = [[...sock, "switch-client", "-t", winTarget]];
    if (c.tmux_pane) cmds.push([...sock, "select-pane", "-t", c.tmux_pane]);
    return cmds;
  }
  const argv = [...sock, "attach-session", "-t", c.tmux_session, ";", "select-window", "-t", winTarget];
  if (c.tmux_pane) argv.push(";", "select-pane", "-t", c.tmux_pane);
  return [argv];
}

export async function attachCmd(opts: AttachOpts): Promise<number> {
  const listR = await fetch(`${opts.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { console.error(`hub error ${listR.status}`); return 1; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { console.error(res.error); return 2; }

  const r = await fetch(`${opts.hubUrl}/sessions/${res.id}`);
  const { session, usage } = (await r.json()) as {
    session: SessionRow;
    usage: { turn_count: number } | null;
  };

  if (LIVE_STATUSES.includes(session.status) && session.tmux_session && session.tmux_window) {
    const inTmux = !!process.env.TMUX;
    const cmds = buildAttachCommands(
      { tmux_session: session.tmux_session, tmux_window: session.tmux_window, tmux_pane: session.tmux_pane, tmux_socket: session.tmux_socket },
      inTmux,
    );
    // !inTmux yields a single foreground attach (inherit stdio so it takes the
    // terminal); inTmux yields quick non-blocking switch/select commands.
    for (const args of cmds) {
      if (inTmux) await $`tmux ${args}`.quiet();
      else await $`tmux ${args}`;
    }
    return 0;
  }

  // dead / lost: relaunch under the same session_id, resuming natively if the
  // adapter supports it (spec §6.4). buildRelaunchSpec encapsulates the choice.
  const spec = buildRelaunchSpec(session, {
    hubUrl: opts.hubUrl,
    wrapBin: opts.wrapBin,
    registry: opts.registry ?? createDefaultRegistry(),
    baseEnv: process.env,
    // Zero observed turns (turn_count 0, or no usage row at all) → the adapter
    // watched the session but no turn ever happened, so no native conversation
    // was persisted and a resume would fail ("No conversation found"). A
    // native_session_id can only come from an attached adapter, so a missing
    // usage row safely means "watched, zero turns" — relaunch fresh.
    turnCount: usage?.turn_count ?? 0,
    loadProfileEnv,
  });
  const child = Bun.spawn(spec.wrapArgv, {
    stdio: ["inherit", "inherit", "inherit"],
    env: spec.env,
  });
  await child.exited;
  return child.exitCode ?? 0;
}
