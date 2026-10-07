import type { SessionRow, SeenSource } from "@agmux/protocol";

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
  source: SeenSource,
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
  // tmux server socket of `pane` (#{socket_path}). Pane ids are per-server, so
  // when given, a session recorded on a different server never matches.
  socket?: string;
  // Why: "dismiss" (explicit key / CLI, the default) or "focus" (the tmux
  // pane-focus-in hook installed by agmux.tmux).
  source?: SeenSource;
  hubUrl: string;
  host: string;
}

// Resolve a tmux pane id to the open session that currently owns it, by
// matching against the sessions' `tmux_pane` (and, when both sides know it,
// `tmux_socket`). Returns null when no open session owns the pane (e.g. the key
// was pressed in an unrelated pane) or the hub can't be reached — callers must
// treat that as "nothing to do", not an error.
export async function resolvePane(
  pane: string, hubUrl: string, fetchImpl: typeof fetch, socket?: string,
): Promise<SessionRow | null> {
  try {
    const r = await fetchImpl(`${hubUrl}/sessions?status=open`);
    if (!r.ok) return null;
    const { sessions } = (await r.json()) as { sessions: SessionRow[] };
    return sessions.find((s) => s.tmux_pane === pane
      && (!socket || !s.tmux_socket || s.tmux_socket === socket)) ?? null;
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
    const row = await resolvePane(opts.pane, opts.hubUrl, deps.fetchImpl, opts.socket);
    // No session owns this pane: pressing the key in an unrelated pane is not
    // an error and must produce no output. Only a `done` session has anything
    // to acknowledge — this path runs on every pane switch (pane-focus-in), and
    // a seen for a running/waiting/idle session would only pad the event log.
    if (!row || row.status !== "done") return 0;
    sessionId = row.session_id;
  }
  if (!sessionId) return 2;
  const ok = await postSeen(sessionId, opts.source ?? "dismiss", { ...deps, hubUrl: opts.hubUrl, host: opts.host });
  return ok ? 0 : 1;
}
