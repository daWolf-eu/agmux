/** @jsxImportSource @opentui/react */
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import type { PreviewMode, UsageSummary } from "../types.ts";

function header(row: SessionRow): string {
  return `${row.session_id.slice(0, 13)} · ${row.agent_kind}${row.profile ? ` · ${row.profile}` : ""}`;
}

function Body(props: {
  row: SessionRow; mode: PreviewMode; mirrorText: string; events: EventEnvelope[]; usage: UsageSummary | null; maxBodyLines: number;
}) {
  if (props.mode === "mirror") {
    const lines = props.mirrorText ? props.mirrorText.split("\n").slice(-props.maxBodyLines) : [];
    if (lines.length === 0) return <text fg="#6c7086">no mirror output</text>;
    return <text>{lines.join("\n")}</text>;
  }
  if (props.mode === "events") {
    const lines = props.events.slice(-props.maxBodyLines).map((e) => `${e.ts?.slice(11, 19) ?? ""} ${e.kind}`);
    if (lines.length === 0) return <text fg="#6c7086">no events</text>;
    return <text>{lines.join("\n")}</text>;
  }
  // detail
  const u = props.usage;
  return (
    <box style={{ flexDirection: "column" }}>
      <text>status: {props.row.status}</text>
      <text>turns: {props.row.turn_count ?? "-"}</text>
      {u ? <text>tokens: {u.input_tokens}/{u.output_tokens}  cost: ${u.cost_usd.toFixed(4)}</text> : <text fg="#6c7086">no usage</text>}
    </box>
  );
}

export function PreviewPane(props: {
  row: SessionRow | null; mode: PreviewMode; mirrorText: string;
  events: EventEnvelope[]; usage: UsageSummary | null; maxBodyLines: number;
}) {
  if (!props.row) return <text fg="#6c7086">no selection</text>;
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <text fg="#6c7086">{header(props.row)}</text>
      <text fg="#45475a">{"─".repeat(20)}</text>
      <Body row={props.row} mode={props.mode} mirrorText={props.mirrorText} events={props.events} usage={props.usage} maxBodyLines={props.maxBodyLines} />
    </box>
  );
}
