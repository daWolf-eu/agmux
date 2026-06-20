/** @jsxImportSource @opentui/react */
import type { SessionRow } from "@agmux/protocol";

export function HeaderBar(props: { rows: SessionRow[]; connected: boolean; hubUrl: string }) {
  return <text fg="#cba6f7">agmux dash</text>;
}
