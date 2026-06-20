/** @jsxImportSource @opentui/react */
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import type { PreviewMode, UsageSummary } from "../types.ts";

export function PreviewPane(props: {
  row: SessionRow | null; mode: PreviewMode; mirrorText: string;
  events: EventEnvelope[]; usage: UsageSummary | null; maxBodyLines: number;
}) {
  return <text>{props.row ? props.row.session_id : "no selection"}</text>;
}
