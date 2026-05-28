import type { SessionRow } from "@agmux/protocol";
import { resolvePrefix } from "./id-resolve.ts";

export interface KillOpts { idOrPrefix: string; signal: string; hubUrl: string; }

export async function killCmd(opts: KillOpts): Promise<number> {
  const listR = await fetch(`${opts.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { console.error(`hub error ${listR.status}`); return 1; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { console.error(res.error); return 2; }

  const r = await fetch(`${opts.hubUrl}/sessions/${res.id}`);
  const { session } = (await r.json()) as { session: SessionRow };
  if (!session.pid) { console.error(`session has no recorded pid; nothing to signal`); return 1; }
  try {
    process.kill(session.pid, opts.signal as NodeJS.Signals);
    console.log(`signaled pid ${session.pid} with ${opts.signal}`);
    return 0;
  } catch (e: any) {
    console.error(`kill failed: ${e?.message ?? e}`);
    return 1;
  }
}
