import type { EventEnvelope, SessionRow } from "@agmux/protocol";
import { resolvePrefix } from "./id-resolve.ts";

export interface InspectOpts { idOrPrefix: string; hubUrl: string; }

export async function inspectCmd(opts: InspectOpts): Promise<number> {
  const listR = await fetch(`${opts.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { console.error(`hub error ${listR.status}`); return 1; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { console.error(res.error); return 2; }

  const r = await fetch(`${opts.hubUrl}/sessions/${res.id}`);
  if (!r.ok) { console.error(`hub error ${r.status}`); return 1; }
  const body = (await r.json()) as { session: SessionRow; events: EventEnvelope[] };
  console.log(JSON.stringify(body, null, 2));
  return 0;
}
