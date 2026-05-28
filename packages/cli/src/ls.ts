import type { SessionRow } from "@agmux/protocol";

export interface LsOpts {
  live: boolean;   // --live → only idle/running/waiting
  all: boolean;    // --all → no row cap
  agent?: string;
  profile?: string;
  hubUrl: string;
}

const DEFAULT_LIMIT = 50;
const ALL_LIMIT = 10000;

export async function lsCmd(opts: LsOpts): Promise<number> {
  const qs = new URLSearchParams();
  if (opts.live) qs.set("live", "1");
  if (opts.agent) qs.set("agent_kind", opts.agent);
  if (opts.profile) qs.set("profile", opts.profile);
  qs.set("limit", String(opts.all ? ALL_LIMIT : DEFAULT_LIMIT));
  const r = await fetch(`${opts.hubUrl}/sessions?${qs.toString()}`);
  if (!r.ok) { console.error(`hub error ${r.status}`); return 1; }
  const { sessions } = (await r.json()) as { sessions: SessionRow[] };
  printTable(sessions);
  return 0;
}

function printTable(rows: SessionRow[]): void {
  const header = ["ID", "AGENT", "PROFILE", "STATUS", "PID", "TMUX", "START", "LAST_SEEN"];
  const data = rows.map((r) => [
    r.session_id.slice(0, 8),
    r.agent_kind,
    r.profile ?? "-",
    r.status,
    r.pid?.toString() ?? "-",
    r.tmux_session && r.tmux_window ? `${r.tmux_session}:${r.tmux_window}` : "-",
    short(r.start_ts),
    short(r.last_heartbeat_ts ?? r.start_ts),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length))
  );
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(fmt(header));
  for (const row of data) console.log(fmt(row));
}

function short(iso: string): string {
  // 2026-05-28T12:00:00.000Z → 05-28 12:00
  return iso.slice(5, 16).replace("T", " ");
}
