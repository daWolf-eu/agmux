/** @jsxImportSource @opentui/react */
import type { SessionRow, SessionStatus } from "@agmux/protocol";
import type { ActivityGroup } from "../shared/group.ts";

function count(rows: SessionRow[], s: SessionStatus[]): number {
  return rows.filter((r) => s.includes(r.status)).length;
}

// `rows` here is the full fetched set (not the group-filtered view) so the
// counts always reveal how many sessions sit in the groups you can switch to.
export function HeaderBar(props: { rows: SessionRow[]; connected: boolean; hubUrl: string; group: ActivityGroup }) {
  const { rows } = props;
  return (
    <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <text>
        <span fg="#cba6f7">agmux dash</span>
        {"  "}
        <span fg="#89dceb">[{props.group}]</span>
        {"  "}
        <span fg={props.connected ? "#89b4fa" : "#f38ba8"}>{props.connected ? "● connected" : "◌ reconnecting"}</span>
      </text>
      <text>
        <span fg="#6c7086">{rows.length} sessions  </span>
        <span fg="#f9e2af">{count(rows, ["waiting"])} input </span>
        <span fg="#a6e3a1">{count(rows, ["running"])} run </span>
        <span fg="#6c7086">{count(rows, ["idle"])} idle </span>
        <span fg="#585b70">{count(rows, ["ended", "lost"])} closed</span>
      </text>
    </box>
  );
}
