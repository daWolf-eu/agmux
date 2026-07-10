import type { SessionRow } from "@agmux/protocol";

// Pure matcher: which session id (if any) owns the given active pane.
// Pane ids (%N) are server-global but NOT unique across tmux servers, so when a
// socket is known we must match on both socket + pane to avoid cross-server collisions.
export function matchAttachedPane(
  rows: SessionRow[],
  activePane: string | null,
  activeSocket?: string | null,
): string | null {
  if (!activePane) return null;
  // Legacy/test callers pass no socket → pane-only match (current behavior).
  if (activeSocket === undefined) {
    return rows.find((r) => r.tmux_pane === activePane)?.session_id ?? null;
  }
  // Socket known (string OR null): require both to match.
  return rows.find((r) => (r.tmux_socket ?? null) === activeSocket && r.tmux_pane === activePane)?.session_id ?? null;
}

// Side-effecting probe: the active pane of the parent client, or null when not in
// tmux / on any failure. tmux `#{pane_id}` of the active pane in the attached client.
export async function activePaneId(
  runTmux: (args: string[]) => Promise<string> = defaultTmuxText,
): Promise<string | null> {
  if (!process.env.TMUX) return null;
  try {
    const out = await runTmux(["display-message", "-p", "#{pane_id}"]);
    const id = out.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

const defaultTmuxText = async (args: string[]): Promise<string> => {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`tmux exit ${proc.exitCode}`);
  return out;
};
