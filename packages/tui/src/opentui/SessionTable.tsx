/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef } from "react";
import { TextAttributes } from "@opentui/core";
import type { SessionRow } from "@agmux/protocol";
import { COLS, columnWidths, pad, rowCells, type RowCells } from "../shared/columns.ts";
import { statusGlyph } from "../shared/glyph.ts";

export function SessionTable(props: {
  rows: SessionRow[]; selectedId: string | null; attachedId: string | null; now: number; height: number;
  onSelect: (id: string) => void;
}) {
  const { rows, selectedId, attachedId, now } = props;

  const cells = useMemo<RowCells[]>(() => rows.map((r) => rowCells(r, now)), [rows, now]);
  const widths = useMemo(() => columnWidths(cells), [cells]);

  const headerText = useMemo(
    () => "   " + COLS.map((c) => pad(c.header, widths[c.key], "left")).join("  "),
    [widths],
  );

  // Keep the selected row visible without moving the viewport more than needed.
  const boxRef = useRef<any>(null);
  useEffect(() => {
    if (selectedId && boxRef.current?.scrollChildIntoView) {
      boxRef.current.scrollChildIntoView(`row-${selectedId}`);
    }
  }, [selectedId]);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <text fg="#9399b2" attributes={TextAttributes.DIM}>{headerText}</text>
      <scrollbox ref={boxRef} style={{ flexGrow: 1 }} scrollY stickyScroll={false}>
        {rows.map((r, i) => {
          const g = statusGlyph(r);
          const c = cells[i]!;
          const isSel = r.session_id === selectedId;
          const isAtt = r.session_id === attachedId;
          const gutter = isSel ? "▶" : isAtt ? "◆" : " ";
          const gutterColor = isSel ? "#ffffff" : isAtt ? "#94e2d5" : "#6c7086";
          return (
            <box key={r.session_id} id={`row-${r.session_id}`} onMouseDown={() => props.onSelect(r.session_id)} style={{ flexDirection: "row", backgroundColor: isSel ? "#313244" : undefined }}>
              <text fg={gutterColor}>{gutter} </text>
              <text fg={g.color}>{g.glyph} </text>
              <text fg={isSel ? "#ffffff" : "#9399b2"}>{pad(c.id, widths.id, "left")}  </text>
              <text fg={isSel ? "#ffffff" : "#89b4fa"}>{pad(c.tmux, widths.tmux, "left")}  </text>
              <text fg={isSel ? "#ffffff" : "#cdd6f4"}>{pad(c.agent, widths.agent, "left")}  </text>
              <text fg={isSel ? "#ffffff" : "#cdd6f4"}>{pad(c.profile, widths.profile, "left")}  </text>
              <text fg={isSel ? "#ffffff" : "#cdd6f4"}>{pad(c.turns, widths.turns, "right")}  </text>
              <text fg={isSel ? "#ffffff" : "#cdd6f4"}>{pad(c.last, widths.last, "right")}</text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
