import type { SessionRow } from "@agmux/protocol";
import type { LsQueryOpts } from "./parse-ls.ts";

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

export function formatTable(rows: SessionRow[], reverse: boolean): string[] {
  const header = ["ID", "AGENT", "PROFILE", "STATUS", "TURNS", "PID", "TMUX", "START", "LAST_SEEN"];
  const data = rows.map((r) => [
    r.session_id.slice(0, 23),
    r.agent_kind,
    r.profile ?? "-",
    r.status,
    // "-" = no adapter observation; "0" = adapter watched but no turn happened
    // (nothing to resume); >0 = a real conversation.
    r.turn_count == null ? "-" : String(r.turn_count),
    r.pid?.toString() ?? "-",
    r.tmux_session && r.tmux_window ? `${r.tmux_session}:${r.tmux_window}` : "-",
    short(r.start_ts),
    short(r.last_heartbeat_ts ?? r.start_ts),
  ]);
  // -r flips data rows only — the header stays on top.
  if (reverse) data.reverse();
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length))
  );
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [fmt(header), ...data.map(fmt)];
}

function short(iso: string): string {
  // 2026-05-28T12:00:00.000Z → 05-28 12:00
  return iso.slice(5, 16).replace("T", " ");
}
