// Which terminal multiplexer hosts a session. A null `mux` on a session row
// means tmux, so tmux payloads stay byte-identical: `mux` and `mux_label` are
// only ever written for Rex.
export type MuxKind = "tmux" | "rex";

import { stripControls } from "./host.ts";

// Env vars Rex sets inside a block.
export const REX_ENV_KEYS = ["REX_BLOCK", "REX_SESSION", "REX_SERVER"] as const;

// TMUX wins over REX_*: a tmux running inside a Rex block is tmux.
export function detectMux(env: Record<string, string | undefined>): MuxKind | null {
  if (env.TMUX) return "tmux";
  if (env.REX_BLOCK) return "rex";
  return null;
}

export function rowMux(row: { mux?: MuxKind | null }): MuxKind {
  return row.mux ?? "tmux";
}

// Where a session lives, for display. Rex rows show the human label (or the
// last 8 chars of the block id when unlabelled), never the raw UUID; tmux rows
// keep "session:window". "" when there is no location.
export function muxLocationText(row: {
  mux?: MuxKind | null; mux_label?: string | null; tmux_session: string | null; tmux_window: string | null;
}): string {
  if (rowMux(row) === "rex") {
    const label = row.mux_label ? stripControls(row.mux_label) : "";
    if (label) return `rex:${label}`;
    return row.tmux_session ? `rex:${row.tmux_session.slice(-8)}` : "";
  }
  return row.tmux_session && row.tmux_window ? `${row.tmux_session}:${row.tmux_window}` : "";
}
