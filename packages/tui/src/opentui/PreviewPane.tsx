/** @jsxImportSource @opentui/react */
import type { SessionRow } from "@agmux/protocol";
import type { UsageSummary } from "../types.ts";
import { pad } from "../shared/columns.ts";

// The OpenTUI dash has exactly two preview tabs (the Ink dash keeps its own
// three-tab PreviewMode incl. "events"). Kept local so the shared type and the
// `--preview` CLI flag are untouched.
export type PreviewTab = "mirror" | "detail";

function shortHeader(row: SessionRow): string {
  return `${row.session_id.slice(0, 13)} · ${row.agent_kind}${row.profile ? ` · ${row.profile}` : ""}`;
}

function tmuxFull(r: SessionRow): string {
  if (!r.tmux_session || !r.tmux_window) return "—";
  return `${r.tmux_session}:${r.tmux_window}${r.tmux_pane ? ` ${r.tmux_pane}` : ""}`;
}

function exitStr(r: SessionRow): string {
  if (r.exit_code != null) return `code ${r.exit_code}`;
  if (r.signal) return `signal ${r.signal}`;
  return "-";
}

// Full technical detail — no truncation. Long values wrap inside the scrollbox.
function DetailBody(props: { row: SessionRow; usage: UsageSummary | null }) {
  const r = props.row;
  const u = props.usage;
  const fields: [string, string][] = [
    ["ID", r.session_id],
    ["Status", r.status],
    ["Agent", r.agent_kind],
    ["Profile", r.profile ?? "-"],
    ["Origin", r.origin],
    ["TMUX", tmuxFull(r)],
    ["PID", r.pid == null ? "-" : String(r.pid)],
    ["Host", r.host],
    ["Project", r.project ?? "-"],
    ["CWD", r.cwd],
    ["Command", [r.command, ...r.args].join(" ")],
    ["Native ID", r.native_session_id ?? "-"],
    ["Parent", r.parent_session_id ?? "-"],
    ["Created", r.start_ts],
    ["Last seen", r.last_heartbeat_ts ?? "-"],
    ["Ended", r.end_ts ?? "-"],
    ["Exit", exitStr(r)],
    ["Turns", r.turn_count == null ? "-" : String(r.turn_count)],
  ];
  if (u) {
    fields.push(["Tokens", `${u.input_tokens} in / ${u.output_tokens} out`]);
    fields.push(["Cost", `$${u.cost_usd.toFixed(4)}`]);
    fields.push(["Model", u.last_model ?? "-"]);
  }
  const lw = fields.reduce((m, [k]) => Math.max(m, k.length), 0);
  return (
    <box style={{ flexDirection: "column" }}>
      {fields.map(([k, v], i) => (
        <text key={i}>
          <span fg="#6c7086">{pad(k, lw, "left")}</span>
          <span fg="#cdd6f4">{"  " + v}</span>
        </text>
      ))}
    </box>
  );
}

function MirrorBody(props: { text: string }) {
  if (!props.text) return <text fg="#6c7086">no mirror output</text>;
  // Render the tail; the scrollbox clips to the pane and sticks to newest output.
  const lines = props.text.split("\n").slice(-1000);
  return <text>{lines.join("\n")}</text>;
}

export function PreviewPane(props: {
  row: SessionRow | null; mode: PreviewTab; mirrorText: string; usage: UsageSummary | null;
  // Exact rows available to the scrollable body (terminal height minus the header
  // bar, footer, panel border, and this pane's header+divider). An EXPLICIT height
  // is required: flex alone (even with minHeight:0) lets the scrollbox grow past
  // its slot when content overflows, which pushed the footer off-screen.
  viewportHeight: number;
}) {
  if (!props.row) return <text fg="#6c7086">no selection</text>;
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <text fg="#6c7086">{shortHeader(props.row)}</text>
      <text fg="#45475a">{"─".repeat(20)}</text>
      {/* scrollbox is clamped to viewportHeight → it can never overflow and push
          the footer; mirror sticks to the newest output, detail starts at top. */}
      <scrollbox
        style={{ height: Math.max(1, props.viewportHeight) }}
        scrollY
        stickyScroll={props.mode === "mirror"}
        stickyStart="bottom"
      >
        {props.mode === "mirror"
          ? <MirrorBody text={props.mirrorText} />
          : <DetailBody row={props.row} usage={props.usage} />}
      </scrollbox>
    </box>
  );
}
