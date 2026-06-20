/** @jsxImportSource @opentui/react */
import type { SessionRow } from "@agmux/protocol";

export function SessionTable(props: {
  rows: SessionRow[]; selectedId: string | null; attachedId: string | null; now: number; height: number;
  onSelect: (id: string) => void;
}) {
  return <text>{props.rows.length} sessions</text>;
}
