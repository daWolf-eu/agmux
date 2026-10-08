/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef } from "react";
import { TextAttributes } from "@opentui/core";
import type { SessionRow } from "@agmux/protocol";
import {
  COLUMNS, columnWidths, gapAfter, fitCell, fitWidths, rowCells,
  type ColumnKey, type ColumnStyle, type RowCells,
} from "../shared/columns.ts";
import { statusGlyph } from "../shared/glyph.ts";
import { ageColor } from "../shared/reltime.ts";
import { MOCHA, FAINT_SCROLLBAR } from "../shared/palette.ts";
import { sortDirection, type SortKey } from "../shared/sort.ts";

// Each row is ONE <text> built from colored <span> segments. A single text buffer
// preserves all whitespace exactly (OpenTUI trims lone spaces at the boundary
// *between* sibling <text> flex items, which would misalign columns) — so the
// gutter and every column line up under the header, which is also a single
// string. Inter-column gaps ride inside each segment's trailing spaces.

// Gutter: `▌` (state-coloured selection bar) or `•` (attached pane), then a space.
const GUTTER = 2;
// The scrollbar is drawn over the rightmost cell, so rows never use it.
const SCROLLBAR = 1;

const SEL_BG = MOCHA.surface0;
const H_DIM = MOCHA.overlay0;   // inactive header
const H_HI = MOCHA.text;        // active sort column header
const H_MARK = MOCHA.yellow;    // sort-direction marker

// On the selection background the two faintest greys vanish; lift them to the
// faintest one that still reads.
function onSelection(c: string): string {
  return c === MOCHA.surface1 || c === MOCHA.surface2 ? MOCHA.overlay0 : c;
}

function cellColor(style: ColumnStyle, state: string, r: SessionRow, now: number): string {
  switch (style) {
    case "state": return state;
    case "faint": return MOCHA.overlay0;
    case "accent": return MOCHA.pink;
    case "sub": return MOCHA.subtext0;
    case "age": return ageColor(r.last_heartbeat_ts ?? r.start_ts, now);
  }
}

interface Seg { t: string; c: string; bold?: boolean }

export function SessionTable(props: {
  rows: SessionRow[]; selectedId: string | null; attachedId: string | null; now: number;
  columns: ColumnKey[]; showHeader: boolean;
  // Cells available to a row (pane width minus padding); columns shrink to fit.
  width: number;
  // Rows available to the table (incl. the header row when shown).
  height: number;
  // Spinner frame for running rows.
  frame: number;
  sortKey: SortKey; onSelect: (id: string) => void;
}) {
  const { rows, selectedId, attachedId, now, columns, showHeader, sortKey, frame } = props;

  const cells = useMemo<RowCells[]>(() => rows.map((r) => rowCells(r, columns, now)), [rows, columns, now]);
  const widths = useMemo(
    () => fitWidths(columns, columnWidths(columns, cells, showHeader), props.width - GUTTER - SCROLLBAR),
    [columns, cells, showHeader, props.width],
  );

  // Header is one <text> of colored spans: the sorted column is highlighted and
  // carries a direction marker tucked into its trailing gap (no width change).
  const headerSegs = useMemo<Seg[]>(() => {
    const segs: Seg[] = [{ t: " ".repeat(GUTTER), c: H_DIM }];
    const arrow = sortDirection(sortKey) === "desc" ? "▾" : "▴";
    columns.forEach((k, idx) => {
      const def = COLUMNS[k];
      const active = k === sortKey;
      const gap = gapAfter(columns, idx);
      // The glyph column is 1 wide with no title: its marker takes the cell itself.
      if (k === "glyph") segs.push(active ? { t: arrow, c: H_MARK } : { t: " ", c: H_DIM });
      else segs.push({ t: fitCell(def.header, widths[k] ?? 0, def.align), c: active ? H_HI : H_DIM });
      if (active && k !== "glyph") segs.push({ t: arrow, c: H_MARK }, { t: gap.slice(1), c: H_DIM });
      else segs.push({ t: gap, c: H_DIM });
    });
    return segs;
  }, [columns, widths, sortKey]);

  // Keep the selected row visible without moving the viewport more than needed.
  const boxRef = useRef<any>(null);
  useEffect(() => {
    if (selectedId && boxRef.current?.scrollChildIntoView) {
      boxRef.current.scrollChildIntoView(`row-${selectedId}`);
    }
  }, [selectedId]);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      {showHeader && (
        <text wrapMode="none">{headerSegs.map((s, j) => <span key={j} fg={s.c}>{s.t}</span>)}</text>
      )}
      <scrollbox
        ref={boxRef} style={{ flexGrow: 1, minHeight: 0 }} scrollY stickyScroll={false}
        verticalScrollbarOptions={{ ...FAINT_SCROLLBAR, visible: rows.length > props.height - (showHeader ? 1 : 0) }}
      >
        {rows.map((r, i) => {
          const g = statusGlyph(r, frame);
          const c = cells[i]!;
          const isSel = r.session_id === selectedId;
          const isAtt = r.session_id === attachedId;
          const gutter: Seg = isSel
            ? { t: "▌ ", c: g.color }
            : { t: isAtt ? "• " : "  ", c: MOCHA.teal };
          const segs: Seg[] = [gutter];
          columns.forEach((k, idx) => {
            const def = COLUMNS[k];
            const gap = gapAfter(columns, idx);
            const raw = k === "glyph" ? g.glyph : (c[k] ?? "");
            const color = cellColor(def.style, g.color, r, now);
            segs.push({
              t: fitCell(raw, widths[k] ?? 0, def.align, def.shorten) + gap,
              c: isSel ? onSelection(color) : color,
              bold: k === "name",
            });
          });
          return (
            <box key={r.session_id} id={`row-${r.session_id}`} onMouseDown={() => props.onSelect(r.session_id)} style={{ backgroundColor: isSel ? SEL_BG : undefined }}>
              <text wrapMode="none">
                {segs.map((s, j) => (
                  <span key={j} fg={s.c} attributes={s.bold ? TextAttributes.BOLD : undefined}>{s.t}</span>
                ))}
              </text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
