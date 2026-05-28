import { $ } from "bun";
import type { SessionRow } from "@agmux/protocol";
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV, LIVE_STATUSES } from "@agmux/protocol";
import { resolvePrefix } from "./id-resolve.ts";

export interface AttachOpts { idOrPrefix: string; hubUrl: string; wrapBin: string; }

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

  // dead / lost: relaunch the wrapper under the same session_id.
  // Profile mode → wrapper re-loads from config.toml by name.
  // Ad-hoc mode (profile is null) → reconstruct the inline profile from the stored
  // command/args/env so we can resume without the user re-typing the invocation.
  const childEnv: Record<string, string> = {
    ...process.env,
    [AGMUX_SESSION_ID_ENV]: session.session_id,
    [AGMUX_HUB_URL_ENV]: opts.hubUrl,
  };
  let wrapArgv: string[];
  if (session.profile) {
    wrapArgv = [opts.wrapBin, session.profile];
  } else {
    const inlineProfile = {
      agent_kind: session.agent_kind,
      command: session.command,
      args: session.args,
      env: session.env_overrides ?? {},
    };
    childEnv.AGMUX_INLINE_PROFILE = JSON.stringify(inlineProfile);
    wrapArgv = [opts.wrapBin, session.command.split("/").pop() ?? "agent"];
  }
  const child = Bun.spawn(wrapArgv, {
    stdio: ["inherit", "inherit", "inherit"],
    env: childEnv,
  });
  await child.exited;
  return child.exitCode ?? 0;
}
