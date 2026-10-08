/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import type { SessionRow } from "@agmux/protocol";
import type { ActivityGroup } from "../shared/group.ts";
import { STATUS_COLORS, TONES, statusTone, toneGlyph, type StatusTone } from "../shared/glyph.ts";
import { MOCHA } from "../shared/palette.ts";

// Error rows are closed rows that went wrong; the summary counts them as closed
// (the red glyph on the row already says which).
const SUMMARY_TONES = TONES.filter((t) => t !== "error");

function summaryTone(r: SessionRow): StatusTone {
  const t = statusTone(r);
  return t === "error" ? "closed" : t;
}

// `rows` here is the current group's fetched set before search/sort narrowing.
// Each group queries the hub separately, so the counts describe what this
// group's query returned — in `open` the closed count is 0 by construction.
export function HeaderBar(props: { rows: SessionRow[]; connected: boolean; hubUrl: string; group: ActivityGroup; frame: number }) {
  const { rows } = props;
  const counts = new Map<StatusTone, number>();
  for (const r of rows) counts.set(summaryTone(r), (counts.get(summaryTone(r)) ?? 0) + 1);
  // Zero counts are hidden; "waiting" is the one that needs you, so it is bold.
  const parts = SUMMARY_TONES.filter((t) => (counts.get(t) ?? 0) > 0);
  return (
    <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <text>
        <span fg={MOCHA.mauve}>agmux dash</span>
        {"  "}
        <span fg={MOCHA.sky}>[{props.group}]</span>
        {"  "}
        <span fg={props.connected ? MOCHA.blue : MOCHA.red}>{props.connected ? "● connected" : "◌ reconnecting"}</span>
      </text>
      <text>
        <span fg={MOCHA.overlay0}>{rows.length} sessions</span>
        {parts.map((t) => (
          <span key={t} fg={STATUS_COLORS[t]} attributes={t === "waiting" ? TextAttributes.BOLD : undefined}>
            {`   ${toneGlyph(t, props.frame)} ${counts.get(t)} ${t}`}
          </span>
        ))}
      </text>
    </box>
  );
}
