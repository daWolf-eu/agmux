/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef } from "react";
import type { SessionRow } from "@agmux/protocol";
import { COLS, columnWidths, pad, rowCells, type RowCells } from "../shared/columns.ts";
import { statusGlyph } from "../shared/glyph.ts";
import type { SortKey } from "../shared/sort.ts";

// Each row is ONE <text> built from colored <span> segments. A single text buffer
// preserves all whitespace exactly (OpenTUI trims lone spaces at the boundary
// *between* sibling <text> flex items, which would misalign columns) — so the
// gutter, glyph, and every column line up under the header, which is also a
// single string. Inter-segment gaps live inside each segment's trailing spaces.
const GAP = "  "; // 2-space column separator, matches the header join

// Prefix = gutter(1)+1 space + glyph(1)+2 spaces = 5 cols. The header's leading
// pad must equal this so column titles sit above their values.
const PREFIX = 5;

// Direction marker per sort key (down = newest/priority first, up = a→z). The
// marker rides inside the existing column gap (or the glyph prefix for "status"),
// so it never changes a column width — alignment is preserved.
const ARROW: Record<SortKey, string> = { status: "▾", last: "▾", id: "▴" };
const H_DIM = "#6c7086";   // inactive header
const H_HI = "#cdd6f4";    // active sort column header
const H_MARK = "#f9e2af";  // sort-direction marker

export function SessionTable(props: {
  rows: SessionRow[]; selectedId: string | null; attachedId: string | null; now: number; height: number;
  sortKey: SortKey; onSelect: (id: string) => void;
}) {
  const { rows, selectedId, attachedId, now, sortKey } = props;

  const cells = useMemo<RowCells[]>(() => rows.map((r) => rowCells(r, now)), [rows, now]);
  const widths = useMemo(() => columnWidths(cells), [cells]);

  // Header is one <text> of colored spans: the sorted column is highlighted and
  // carries a direction marker tucked into its gap (no width change).
  const headerSegs = useMemo<{ t: string; c: string }[]>(() => {
    const activeCol = sortKey === "status" ? null : sortKey; // "id" | "last" | null
    const segs: { t: string; c: string }[] = [];
    if (sortKey === "status") segs.push({ t: "  ", c: H_DIM }, { t: ARROW.status, c: H_MARK }, { t: "  ", c: H_DIM });
    else segs.push({ t: " ".repeat(PREFIX), c: H_DIM });
    COLS.forEach((c, idx) => {
      const isActive = c.key === activeCol;
      segs.push({ t: pad(c.header, widths[c.key], "left"), c: isActive ? H_HI : H_DIM });
      const isLast = idx === COLS.length - 1;
      if (!isLast) {
        if (isActive) segs.push({ t: ARROW[sortKey], c: H_MARK }, { t: " ", c: H_DIM });
        else segs.push({ t: GAP, c: H_DIM });
      } else if (isActive) {
        segs.push({ t: " " + ARROW[sortKey], c: H_MARK });
      }
    });
    return segs;
  }, [widths, sortKey]);

  // Keep the selected row visible without moving the viewport more than needed.
  const boxRef = useRef<any>(null);
  useEffect(() => {
    if (selectedId && boxRef.current?.scrollChildIntoView) {
      boxRef.current.scrollChildIntoView(`row-${selectedId}`);
    }
  }, [selectedId]);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <text>{headerSegs.map((s, j) => <span key={j} fg={s.c}>{s.t}</span>)}</text>
      <scrollbox ref={boxRef} style={{ flexGrow: 1, minHeight: 0 }} scrollY stickyScroll={false}>
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
