import { $ } from "bun";
import type { SessionRow } from "@agmux/protocol";
import { LIVE_STATUSES } from "@agmux/protocol";
import { createDefaultRegistry, type Registry } from "@agmux/adapters";
import { buildRelaunchSpec } from "./relaunch.ts";
import { resolvePrefix } from "./id-resolve.ts";

export interface AttachOpts { idOrPrefix: string; hubUrl: string; wrapBin: string; registry?: Registry; }

export async function attachCmd(opts: AttachOpts): Promise<number> {
  const listR = await fetch(`${opts.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { console.error(`hub error ${listR.status}`); return 1; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { console.error(res.error); return 2; }

  const r = await fetch(`${opts.hubUrl}/sessions/${res.id}`);
  const { session } = (await r.json()) as { session: SessionRow };

  if (LIVE_STATUSES.includes(session.status) && session.tmux_session && session.tmux_window) {
    if (process.env.TMUX) {
      await $`tmux switch-client -t ${session.tmux_session}:${session.tmux_window}`;
    } else {
      await $`tmux attach -t ${session.tmux_session} \\; select-window -t ${session.tmux_session}:${session.tmux_window}`;
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
  });
  const child = Bun.spawn(spec.wrapArgv, {
    stdio: ["inherit", "inherit", "inherit"],
    env: spec.env,
  });
  await child.exited;
  return child.exitCode ?? 0;
}
