import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { SessionRow } from "@agmux/protocol";
import { buildDashTable } from "./group-table.ts";
import { truncateLine } from "./preview.tsx";

function SessionListImpl({ rows, selectedId, width = Infinity }: { rows: SessionRow[]; selectedId: string | null; width?: number }) {
  // The table layout only depends on the rows, not the selection — memoize so
  // moving the cursor (and the 1s preview poll) doesn't recompute column widths.
  const table = useMemo(() => buildDashTable(rows), [rows]);
  // Truncate to the column width so a wide row never wraps onto a second line
  // (wrapping inflates the frame height and triggers Ink's full-screen flicker).
  const fit = (s: string) => truncateLine(s, width);
  return (
    <Box flexDirection="column">
      <Text dimColor>{fit("  " + table.header)}</Text>
      {table.groups.map((g) => (
        <Box key={g.key} flexDirection="column">
          <Text color="yellow">{fit(`${g.label} (${g.count})`)}</Text>
          {g.rows.map((dr) => {
            const sel = dr.row.session_id === selectedId;
            return (
              <Text key={dr.row.session_id} inverse={sel}>
                {fit((sel ? "› " : "  ") + dr.text)}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

// Memoized so a preview-only state change (mirror poll, mode toggle) doesn't
// re-render the whole table — only rows/selection changes matter here.
export const SessionList = React.memo(SessionListImpl);
