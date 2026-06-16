import type { SessionRow } from "@agmux/protocol";
import type { UsageSummary } from "./types.ts";

// Lines for the "detail" preview tab. Pure: data comes from the row + optional usage.
export function detailLines(row: SessionRow, usage: UsageSummary | null): string[] {
  const tmux = row.tmux_session && row.tmux_window
    ? `${row.tmux_session}:${row.tmux_window}${row.tmux_pane ? `.${row.tmux_pane}` : ""}`
    : "-";
  const lines = [
    `status   ${row.status}`,
    `agent    ${row.agent_kind}${row.profile ? ` (${row.profile})` : ""}`,
    `project  ${row.project ?? "-"}`,
    `command  ${[row.command, ...row.args].join(" ")}`,
    `pid      ${row.pid ?? "-"}`,
    `tmux     ${tmux}`,
    `turns    ${row.turn_count ?? "-"}`,
    `started  ${row.start_ts}`,
    `last     ${row.last_heartbeat_ts ?? "-"}`,
  ];
  if (usage) {
    lines.push(
      `tokens   in ${usage.input_tokens} · out ${usage.output_tokens}`,
      `model    ${usage.last_model ?? "-"}`,
      `cost     $${usage.cost_usd.toFixed(2)}`,
    );
  }
  return lines;
}
