import type { SessionRow } from "@agmux/protocol";
import { formatTable } from "@agmux/tui";
import type { LsQueryOpts } from "./parse-ls.ts";

export { formatTable };

export interface LsOpts extends LsQueryOpts {
  hubUrl: string;
}

export function buildLsQuery(opts: LsQueryOpts): URLSearchParams {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.agent) qs.set("agent_kind", opts.agent);
  if (opts.profile) qs.set("profile", opts.profile);
  qs.set("sort", opts.sort);
  qs.set("order", opts.asc ? "asc" : "desc");
  qs.set("limit", String(opts.limit));
  return qs;
}

export async function lsCmd(opts: LsOpts): Promise<number> {
  const r = await fetch(`${opts.hubUrl}/sessions?${buildLsQuery(opts).toString()}`);
  if (!r.ok) { console.error(`hub error ${r.status}`); return 1; }
  const { sessions } = (await r.json()) as { sessions: SessionRow[] };
  for (const line of formatTable(sessions, opts.reverse)) console.log(line);
  return 0;
}
