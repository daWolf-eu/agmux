import type { SessionRow } from "@agmux/protocol";

// Remote rows (replicated from a sandbox hub) are read-only on this host: their
// pid and tmux coords mean nothing here. Returns the refusal message, or null
// when the row is local and the verb may proceed.
export function remoteRefusal(
  row: Pick<SessionRow, "remote" | "host" | "session_id">,
  verb: "attach" | "resume" | "kill",
): string | null {
  if (!row.remote) return null;
  return `${verb}: ${row.session_id.slice(0, 8)} runs on ${row.host}; remote ${verb} is not supported yet`;
}
