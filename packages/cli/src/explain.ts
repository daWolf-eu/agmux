import type { SessionRow, StatusDecision } from "@agmux/protocol";
import { resolvePrefix } from "./id-resolve.ts";
import { resolvePane } from "./seen.ts";

export interface ExplainOpts {
  idOrPrefix?: string;
  pane?: string;
  json?: boolean;
  hubUrl: string;
}

export interface ExplainDeps {
  fetchImpl: typeof fetch;
  out: (s: string) => void;
  err: (s: string) => void;
}

function at(ts: string | null, now: string): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.parse(now) - Date.parse(ts)) / 1000));
  return `${ts} (${s}s ago)`;
}

// Human rendering of a StatusDecision: the answer first, then each input.
export function formatDecision(d: StatusDecision): string {
  const lines = [
    `session   ${d.session_id}`,
    ...(d.meta?.name ? [`name      ${JSON.stringify(d.meta.name)} (${d.meta.name_source ?? "unknown"})`] : []),
    ...(d.meta?.git_root
      ? [`git       ${d.meta.git_repo ?? "?"} @ ${d.meta.git_branch ?? "detached"} (${d.meta.git_root})`]
      : []),
    `status    ${d.status}${d.status !== d.stored_status ? ` (stored: ${d.stored_status})` : ""}`,
    `because   ${d.reason}`,
    `rule      ${d.rule}`,
    `set by    ${d.status_event.kind ?? "unknown"} at ${at(d.status_event.ts, d.now)}`,
    `attention ${d.attention.kind ?? "none"} at ${at(d.attention.ts, d.now)}`,
    `seen      ${d.seen.source ?? "never"}${d.seen.ts ? ` at ${at(d.seen.ts, d.now)}` : ""}`,
  ];
  if (d.last_input_kind) lines.push(`waiting   for ${d.last_input_kind}`);
  if (d.last_tool) lines.push(`tool      ${d.last_tool}`);
  if (d.title.ts) {
    lines.push(`title     ${JSON.stringify(d.title.title ?? "")} → ${d.title.activity ?? "no signal"} at ${at(d.title.ts, d.now)}`);
  }
  lines.push(`last work ${at(d.last_work_ts, d.now)}`);
  return lines.join("\n");
}

// `agmux explain <id|prefix> | --pane <pane_id>`: why is it in this state?
export async function explainCmd(opts: ExplainOpts, deps: ExplainDeps): Promise<number> {
  let id: string | null = null;
  try {
    if (opts.pane) {
      const row = await resolvePane(opts.pane, opts.hubUrl, deps.fetchImpl);
      if (!row) { deps.err(`no open session owns pane ${opts.pane}`); return 2; }
      id = row.session_id;
    } else if (opts.idOrPrefix) {
      const r = await deps.fetchImpl(`${opts.hubUrl}/sessions?limit=1000`);
      if (!r.ok) { deps.err(`hub error ${r.status}`); return 1; }
      const { sessions } = (await r.json()) as { sessions: SessionRow[] };
      const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
      if (!res.ok) { deps.err(res.error); return 2; }
      id = res.id;
    } else {
      return 2;
    }
    const r = await deps.fetchImpl(`${opts.hubUrl}/sessions/${id}/explain`);
    if (!r.ok) { deps.err(`hub error ${r.status}`); return 1; }
    const { decision } = (await r.json()) as { decision: StatusDecision };
    deps.out(opts.json ? JSON.stringify(decision, null, 2) : formatDecision(decision));
    return 0;
  } catch (e) {
    deps.err(`agmux explain: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
