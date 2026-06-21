/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef } from "react";
import { TextAttributes } from "@opentui/core";
import type { SessionRow } from "@agmux/protocol";
import { COLS, columnWidths, pad, rowCells, type RowCells } from "../shared/columns.ts";
import { statusGlyph } from "../shared/glyph.ts";

// Each row is ONE <text> built from colored <span> segments. A single text buffer
// preserves all whitespace exactly (OpenTUI trims lone spaces at the boundary
// *between* sibling <text> flex items, which would misalign columns) — so the
// gutter, glyph, and every column line up under the header, which is also a
// single string. Inter-segment gaps live inside each segment's trailing spaces.
const GAP = "  "; // 2-space column separator, matches the header join

// Prefix = gutter(1)+1 space + glyph(1)+2 spaces = 5 cols. The header's leading
// pad must equal this so column titles sit above their values.
const PREFIX = 5;

export function SessionTable(props: {
  rows: SessionRow[]; selectedId: string | null; attachedId: string | null; now: number; height: number;
  onSelect: (id: string) => void;
}) {
  const { rows, selectedId, attachedId, now } = props;

  const cells = useMemo<RowCells[]>(() => rows.map((r) => rowCells(r, now)), [rows, now]);
  const widths = useMemo(() => columnWidths(cells), [cells]);

  const headerText = useMemo(
    () => " ".repeat(PREFIX) + COLS.map((c) => pad(c.header, widths[c.key], "left")).join(GAP),
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
          const gutter = isSel ? "›" : isAtt ? "•" : " ";
          const gutterColor = isSel ? "#ffffff" : isAtt ? "#94e2d5" : "#6c7086";
          // Selected row: columns go bright white over the highlight; the status
          // glyph keeps its own color (the one bit of color on a selected row).
          const col = (normal: string) => (isSel ? "#ffffff" : normal);
          const segs: { t: string; c: string }[] = [
            { t: `${gutter} `, c: gutterColor },
            { t: `${g.glyph}${GAP}`, c: g.color },
            { t: pad(c.id, widths.id, "left") + GAP, c: col("#9399b2") },
            { t: pad(c.tmux, widths.tmux, "left") + GAP, c: col("#89b4fa") },
            { t: pad(c.agent, widths.agent, "left") + GAP, c: col("#cdd6f4") },
            { t: pad(c.profile, widths.profile, "left") + GAP, c: col("#cdd6f4") },
            { t: pad(c.turns, widths.turns, "right") + GAP, c: col("#cdd6f4") },
            { t: pad(c.last, widths.last, "right"), c: col("#cdd6f4") },
          ];
          return (
            <box key={r.session_id} id={`row-${r.session_id}`} onMouseDown={() => props.onSelect(r.session_id)} style={{ backgroundColor: isSel ? "#313244" : undefined }}>
              <text>{segs.map((s, j) => <span key={j} fg={s.c}>{s.t}</span>)}</text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
