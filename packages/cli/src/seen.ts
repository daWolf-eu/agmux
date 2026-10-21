import { resolveHost, SESSION_ID_RE, type SessionRow, type SeenSource } from "@agmux/protocol";
import { resolvePrefix } from "./id-resolve.ts";

// `session.seen` is stamped with the host that observed it. For a remote row
// that is this machine, not the sandbox's host (spec §4.5).
export function seenHost(row: Pick<SessionRow, "remote" | "host">): string {
  return row.remote ? resolveHost() : row.host;
}

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

export type ReadPaneOption = (pane: string, socket?: string) => Promise<string | null>;

// Runs on every pane switch: never throws, never prints, null on any failure.
export const defaultReadPaneOption: ReadPaneOption = async (pane, socket) => {
  try {
    const argv = ["tmux", ...(socket ? ["-S", socket] : []), "show-options", "-pqv", "-t", pane, "@agmux_session_id"];
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return out.trim() || null;
  } catch {
    return null;
  }
};

// Resolve a tmux pane id to the open session that currently owns it, by
// matching against the sessions' `tmux_pane` (and, when both sides know it,
// `tmux_socket`). Returns null when no open session owns the pane (e.g. the key
// was pressed in an unrelated pane) or the hub can't be reached — callers must
// treat that as "nothing to do", not an error.
// A pane showing a remote session carries `@agmux_session_id` (set by the
// remote-client while it runs); a canonical UUID there wins over the tmux_pane match.
export async function resolvePane(
  pane: string, hubUrl: string, fetchImpl: typeof fetch, socket?: string,
  readPaneOption: ReadPaneOption = defaultReadPaneOption,
): Promise<SessionRow | null> {
  const sessions = await openSessions(hubUrl, fetchImpl);
  if (!sessions) return null;
  const opt = await readPaneOption(pane, socket).catch(() => null);
  if (opt && SESSION_ID_RE.test(opt)) {
    const id = opt.toLowerCase();
    return sessions.find((s) => s.session_id.toLowerCase() === id) ?? null;
  }
  return sessions.find((s) => s.tmux_pane === pane
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
  deps: Omit<PostSeenDeps, "hubUrl" | "host"> & { fetchImpl: typeof fetch; readPaneOption?: ReadPaneOption },
): Promise<number> {
  // opts.host is the local host (bin passes resolveHost()), right for remote rows too.
  const post = (ids: string | string[]) =>
    postSeen(ids, opts.source ?? "dismiss", {
      fetchImpl: deps.fetchImpl, now: deps.now, newId: deps.newId, hubUrl: opts.hubUrl, host: opts.host,
    });
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
    const row = await resolvePane(opts.pane, opts.hubUrl, deps.fetchImpl, opts.socket, deps.readPaneOption);
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
