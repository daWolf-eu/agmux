import type { SessionRow } from "@agmux/protocol";

export interface PostSeenDeps {
  hubUrl: string;
  host: string;
  fetchImpl: typeof fetch;
  now: () => string;
  newId: () => string;
}

// Never throws: marking a session seen is bookkeeping, and must never be the
// reason an attach fails.
export async function postSeen(
  sessionId: string,
  source: "attach" | "dismiss",
  deps: PostSeenDeps,
): Promise<boolean> {
  try {
    const res = await deps.fetchImpl(`${deps.hubUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{
        event_id: deps.newId(), ts: deps.now(), session_id: sessionId,
        kind: "session.seen", version: 1, host: deps.host, payload: { source },
      }]),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

export interface SeenCmdOpts {
  // Either an explicit session id/prefix, or a tmux pane id to resolve to a
  // session (the tmux keybinding path — spec §8). Exactly one is expected;
  // idOrPrefix wins if both are somehow set.
  idOrPrefix?: string;
  pane?: string;
  hubUrl: string;
  host: string;
}

// Resolve a tmux pane id to the session that currently owns it, by matching
// against the open sessions' `tmux_pane` field. Returns null when no open
// session owns the pane (e.g. the key was pressed in an unrelated pane) or the
// hub can't be reached — callers must treat that as "nothing to do", not an
// error.
async function resolvePane(pane: string, hubUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const r = await fetchImpl(`${hubUrl}/sessions?status=open`);
    if (!r.ok) return null;
    const { sessions } = (await r.json()) as { sessions: SessionRow[] };
    return sessions.find((s) => s.tmux_pane === pane)?.session_id ?? null;
  } catch {
    return null;
  }
}

export async function seenCmd(
  opts: SeenCmdOpts,
  deps: Omit<PostSeenDeps, "hubUrl" | "host"> & { fetchImpl: typeof fetch },
): Promise<number> {
  let sessionId = opts.idOrPrefix ?? null;
  if (!sessionId && opts.pane) {
    sessionId = await resolvePane(opts.pane, opts.hubUrl, deps.fetchImpl);
    // No session owns this pane: pressing the key in an unrelated pane is not
    // an error and must produce no output.
    if (!sessionId) return 0;
  }
  if (!sessionId) return 2;
  const ok = await postSeen(sessionId, "dismiss", { ...deps, hubUrl: opts.hubUrl, host: opts.host });
  return ok ? 0 : 1;
}
