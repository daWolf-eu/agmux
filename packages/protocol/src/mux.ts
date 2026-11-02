// Which terminal multiplexer hosts a session. A null `mux` on a session row
// means tmux, so tmux payloads stay byte-identical: `mux` and `mux_label` are
// only ever written for Rex.
export type MuxKind = "tmux" | "rex";

// Env vars Rex sets inside a block.
export const REX_ENV_KEYS = ["REX_BLOCK", "REX_SESSION", "REX_SERVER"] as const;

// TMUX wins over REX_*: a tmux running inside a Rex block is tmux.
export function detectMux(env: Record<string, string | undefined>): MuxKind | null {
  if (env.TMUX) return "tmux";
  if (REX_ENV_KEYS.some((k) => !!env[k])) return "rex";
  return null;
}

export function rowMux(row: { mux?: MuxKind | null }): MuxKind {
  return row.mux ?? "tmux";
}
