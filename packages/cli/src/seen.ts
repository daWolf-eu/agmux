import type { SessionRow, SeenSource } from "@agmux/protocol";
import { resolvePrefix } from "./id-resolve.ts";

export interface PostSeenDeps {
  hubUrl: string;
  host: string;
  fetchImpl: typeof fetch;
  now: () => string;
  newId: () => string;
}

// Never throws: marking a session seen is bookkeeping, and must never be the
// reason an attach fails.
// Several ids go out as one /ingest batch.
export async function postSeen(
  sessionId: string | string[],
  source: SeenSource,
  deps: PostSeenDeps,
): Promise<boolean> {
  const ids = Array.isArray(sessionId) ? sessionId : [sessionId];
  try {
    const res = await deps.fetchImpl(`${deps.hubUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids.map((id) => ({
        event_id: deps.newId(), ts: deps.now(), session_id: id,
        kind: "session.seen", version: 1, host: deps.host, payload: { source },
      }))),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

export interface SeenCmdOpts {
  // An explicit session id/prefix, a tmux pane id to resolve to a session (the
  // tmux keybinding path — spec §8), or `all`. Exactly one is expected; `all`
  // wins, then idOrPrefix.
  idOrPrefix?: string;
  // Every open `done` session (`agmux seen --all`).
  all?: boolean;
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
  const sessions = await openSessions(hubUrl, fetchImpl);
  return sessions?.find((s) => s.tmux_pane === pane
    && (!socket || !s.tmux_socket || s.tmux_socket === socket)) ?? null;
}

// null when the hub can't be reached.
async function openSessions(hubUrl: string, fetchImpl: typeof fetch): Promise<SessionRow[] | null> {
  try {
    const r = await fetchImpl(`${hubUrl}/sessions?status=open`);
    if (!r.ok) return null;
    return ((await r.json()) as { sessions: SessionRow[] }).sessions;
  } catch {
    return null;
  }
}

export async function seenCmd(
  opts: SeenCmdOpts,
  deps: Omit<PostSeenDeps, "hubUrl" | "host"> & { fetchImpl: typeof fetch },
): Promise<number> {
  const post = (ids: string | string[]) =>
    postSeen(ids, opts.source ?? "dismiss", { ...deps, hubUrl: opts.hubUrl, host: opts.host });
  if (opts.all) {
    const sessions = await openSessions(opts.hubUrl, deps.fetchImpl);
    if (!sessions) return 1;
    const done = sessions.filter((s) => s.status === "done").map((s) => s.session_id);
    if (done.length === 0) return 0;
    return (await post(done)) ? 0 : 1;
  }
  let sessionId: string | null = null;
  if (opts.idOrPrefix) {
    // A prefix (the status line's chips carry 14 chars) names an open session.
    const sessions = await openSessions(opts.hubUrl, deps.fetchImpl);
    if (!sessions) return 1;
    const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
    if (!res.ok) { console.error(res.error); return 2; }
    sessionId = res.id;
  } else if (opts.pane) {
    const row = await resolvePane(opts.pane, opts.hubUrl, deps.fetchImpl, opts.socket);
    // No session owns this pane: pressing the key in an unrelated pane is not
    // an error and must produce no output. Only a `done` session has anything
    // to acknowledge — this path runs on every pane switch (pane-focus-in), and
    // a seen for a running/waiting/idle session would only pad the event log.
    if (!row || row.status !== "done") return 0;
    sessionId = row.session_id;
  }
  if (!sessionId) return 2;
  return (await post(sessionId)) ? 0 : 1;
}
