import type { EventEnvelope, HostRow, SessionRow } from "@agmux/protocol";
import { resolvePrefix } from "./id-resolve.ts";

export interface InspectOpts { idOrPrefix: string; hubUrl: string; }

export interface InspectDeps { fetchImpl?: typeof fetch; out?: (s: string) => void; }

export async function inspectCmd(opts: InspectOpts, deps: InspectDeps = {}): Promise<number> {
  const fetch = deps.fetchImpl ?? globalThis.fetch;
  const out = deps.out ?? ((s: string) => console.log(s));
  const listR = await fetch(`${opts.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { console.error(`hub error ${listR.status}`); return 1; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { console.error(res.error); return 2; }

  const r = await fetch(`${opts.hubUrl}/sessions/${res.id}`);
  if (!r.ok) { console.error(`hub error ${r.status}`); return 1; }
  const body = (await r.json()) as { session: SessionRow; events: EventEnvelope[] };
  let host: HostRow | undefined;
  if (body.session.remote) {
    try {
      const hr = await fetch(`${opts.hubUrl}/hosts`);
      if (hr.ok) {
        const { hosts } = (await hr.json()) as { hosts?: HostRow[] };
        host = hosts?.find((h) => h.host === body.session.host);
      }
    } catch { /* the host row is optional */ }
  }
  out(JSON.stringify(host ? { ...body, host } : body, null, 2));
  return 0;
}
