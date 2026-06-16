import React from "react";
import { Box, Text } from "ink";
import type { SessionRow } from "@agmux/protocol";
import { buildDashTable } from "./group-table.ts";

export function SessionList({ rows, selectedId }: { rows: SessionRow[]; selectedId: string | null }) {
  const table = buildDashTable(rows);
  return (
    <Box flexDirection="column">
      <Text dimColor>{"  " + table.header}</Text>
      {table.groups.map((g) => (
        <Box key={g.key} flexDirection="column">
          <Text color="yellow">{`${g.label} (${g.count})`}</Text>
          {g.rows.map((dr) => {
            const sel = dr.row.session_id === selectedId;
            return (
              <Text key={dr.row.session_id} inverse={sel}>
                {(sel ? "› " : "  ") + dr.text}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
