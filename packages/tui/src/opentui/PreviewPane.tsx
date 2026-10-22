/** @jsxImportSource @opentui/react */
import { stripControls, type SessionRow } from "@agmux/protocol";
import type { PreviewMode, UsageSummary } from "../types.ts";
import { pad } from "../shared/columns.ts";
import { syncAge } from "../shared/reltime.ts";
import { tmuxTarget } from "../shared/yank.ts";
import { MOCHA, FAINT_SCROLLBAR } from "../shared/palette.ts";

const TABS: PreviewMode[] = ["mirror", "detail"];

function shortHeader(row: SessionRow): string {
  return stripControls(`${row.session_id.slice(0, 13)} · ${row.agent_kind}${row.profile ? ` · ${row.profile}` : ""}`);
}

function exitStr(r: SessionRow): string {
  if (r.exit_code != null) return `code ${r.exit_code}`;
  if (r.signal) return `signal ${r.signal}`;
  return "-";
}

// Where attach goes for a remote row: its tmux target inside the sandbox.
function remoteTmuxTarget(r: SessionRow): string {
  const t = r.remote_tmux;
  return t ? `${t.session}:${t.window}${t.pane ? ` ${t.pane}` : ""} (in sandbox)` : "";
}

// Remote rows add when the replica last synced and whether it has gone stale.
export function hostDetail(r: SessionRow, now: number = Date.now()): string {
  let s = r.host;
  if (r.remote && r.last_sync_ts) s += ` · last sync ${syncAge(r.last_sync_ts, now)}`;
  if (r.remote && r.sync_stale) s += " · stale";
  return s;
}

// Full technical detail — no truncation. Long values wrap inside the scrollbox.
// Values reach the terminal and remote ones come from a sandbox: no control characters.
export function detailFields(r: SessionRow, u: UsageSummary | null): [string, string][] {
  const fields: [string, string][] = [
    ["ID", r.session_id],
    ["Status", r.status],
    ["Agent", r.agent_kind],
    ["Profile", r.profile ?? "-"],
    ["Origin", r.origin],
    ["TMUX", tmuxTarget(r) || remoteTmuxTarget(r) || "—"],
    ["PID", r.pid == null ? "-" : String(r.pid)],
    ["Host", hostDetail(r)],
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
  return fields.map(([k, v]) => [k, stripControls(v)]);
}

function DetailBody(props: { row: SessionRow; usage: UsageSummary | null }) {
  const fields = detailFields(props.row, props.usage);
  const lw = fields.reduce((m, [k]) => Math.max(m, k.length), 0);
  return (
    <box style={{ flexDirection: "column" }}>
      {fields.map(([k, v], i) => (
        <text key={i}>
          <span fg={MOCHA.overlay0}>{pad(k, lw, "left")}</span>
          <span fg={MOCHA.text}>{"  " + v}</span>
        </text>
      ))}
    </box>
  );
}

function MirrorBody(props: { text: string }) {
  if (!props.text) return <text fg={MOCHA.overlay0}>no mirror output</text>;
  // Render the tail; the scrollbox clips to the pane and sticks to newest output.
  const lines = props.text.split("\n").slice(-1000);
  return <text>{lines.join("\n")}</text>;
}

export function PreviewPane(props: {
  row: SessionRow | null; mode: PreviewMode; mirrorText: string; usage: UsageSummary | null;
  // Exact rows available to the scrollable body (terminal height minus the header
  // bar and its spacer, footer and its spacer, and this pane's tab line + spacer). An EXPLICIT height
  // is required: flex alone (even with minHeight:0) lets the scrollbox grow past
  // its slot when content overflows, which pushed the footer off-screen.
  viewportHeight: number;
}) {
  if (!props.row) return <text fg={MOCHA.overlay0}>no selection</text>;
  // No pane title: the tab line names the view (active tab bright, `tab` cycles),
  // then a blank line instead of a rule.
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <text wrapMode="none">
        {TABS.map((t) => (
          <span key={t} fg={t === props.mode ? MOCHA.text : MOCHA.surface2}>{`${t}  `}</span>
        ))}
        <span fg={MOCHA.overlay0}>{` ${shortHeader(props.row)}`}</span>
      </text>
      <text> </text>
      {/* scrollbox is clamped to viewportHeight → it can never overflow and push
          the footer; mirror sticks to the newest output, detail starts at top. */}
      <scrollbox
        style={{ height: Math.max(1, props.viewportHeight) }}
        scrollY
        stickyScroll={props.mode === "mirror"}
        stickyStart="bottom"
        verticalScrollbarOptions={FAINT_SCROLLBAR}
      >
        {props.mode === "mirror"
          ? <MirrorBody text={props.mirrorText} />
          : <DetailBody row={props.row} usage={props.usage} />}
      </scrollbox>
    </box>
  );
}
