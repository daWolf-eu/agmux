// `agmux attach <id> --resume-nearest --print-coords`: the sandbox side of a
// remote resume (spec §5.2). Runs inside the sandbox via `sandbox exec --no-tty`
// (no tmux client, $TMUX unset): resumes a local row directly (no wrapper),
// detached, as near to its old tmux spot as the current server allows, and
// prints one PrintedCoords JSON line on stdout. Everything else goes to stderr.
import {
  AGMUX_PROFILE_ENV, AGMUX_TMUX_SESSION_ENV, AGMUX_TMUX_SESSION_DEFAULT, TMUX_SERVER_ID_FMT,
  isTmuxServerId, parseLaunchSpec, parsePrintedCoords, tmuxSocketArgs,
  type LaunchSpec, type PrintedCoords, type SessionRow,
} from "@agmux/protocol";
import { createDefaultRegistry, type Registry } from "@agmux/adapters";
import { buildDirectRelaunch, type ProfileLaunch } from "./relaunch.ts";
import { decideAttach } from "./attach.ts";
import { resolvePrefix } from "./id-resolve.ts";
import { loadProfileLaunch } from "./profile-env.ts";
import {
  hasSession, newSession, newWindow, splitPane, tmuxServerId, type PaneCoords, type TmuxExec,
} from "./tmux-place.ts";

export type NearestTarget =
  | { kind: "split"; window: string }
  | { kind: "window"; session: string }
  | { kind: "session"; name: string };

export interface NearestDeps {
  serverId(socket: string | null): Promise<string | null>;
  windowExists(win: string, socket: string | null): Promise<boolean>;
  hasSession(name: string, socket: string | null): Promise<boolean>;
  splitPane: typeof splitPane;
  newWindow: typeof newWindow;
  newSession: typeof newSession;
}

type NearestRow = Pick<SessionRow, "tmux_session" | "tmux_window" | "tmux_socket" | "tmux_server">;

// Spec §5.2.2: split only into the very window the agent left, i.e. on the same
// tmux server (a restarted server reuses the socket path and `@0`); else a new
// window in the old session; else a new session under the old name.
export async function pickNearest(
  row: NearestRow,
  deps: NearestDeps,
  env: Record<string, string | undefined> = process.env,
): Promise<NearestTarget> {
  const socket = row.tmux_socket;
  if (row.tmux_server && row.tmux_window &&
      (await deps.serverId(socket)) === row.tmux_server &&
      (await deps.windowExists(row.tmux_window, socket))) {
    return { kind: "split", window: row.tmux_window };
  }
  const name = row.tmux_session ?? env[AGMUX_TMUX_SESSION_ENV] ?? AGMUX_TMUX_SESSION_DEFAULT;
  return (await deps.hasSession(name, socket)) ? { kind: "window", session: name } : { kind: "session", name };
}

const defaultExec: TmuxExec = async (args) => {
  const proc = Bun.spawn(["tmux", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`tmux exit ${proc.exitCode}`);
  return out;
};

// Identity of the server on `socket`, or null when none runs. Works without a
// client: tmux falls back to the most recent session for the format.
export async function runningServerId(socket: string | null, exec: TmuxExec = defaultExec): Promise<string | null> {
  try {
    const out = (await exec([...tmuxSocketArgs(socket), "display-message", "-p", TMUX_SERVER_ID_FMT])).trim();
    return isTmuxServerId(out) ? out : null;
  } catch {
    return null;
  }
}

// `display-message -t <missing window>` exits 0 with empty output, so compare
// the printed id (Phase 2 note 12).
async function idExists(id: string, fmt: string, socket: string | null, exec: TmuxExec): Promise<boolean> {
  try {
    return (await exec([...tmuxSocketArgs(socket), "display-message", "-p", "-t", id, fmt])).trim() === id;
  } catch {
    return false;
  }
}

export function windowExists(win: string, socket: string | null, exec: TmuxExec = defaultExec): Promise<boolean> {
  return idExists(win, "#{window_id}", socket, exec);
}

export function paneExists(pane: string, socket: string | null, exec: TmuxExec = defaultExec): Promise<boolean> {
  return idExists(pane, "#{pane_id}", socket, exec);
}

export interface ResumeNearestDeps extends NearestDeps {
  fetchImpl: typeof fetch;
  paneExists(pane: string, socket: string | null): Promise<boolean>;
  paneServerId(pane: string, socket: string | null): Promise<string | null>;
  registry: Registry;
  loadProfileLaunch: (name: string) => ProfileLaunch | undefined;
  err(line: string): void;
}

export const defaultResumeNearestDeps = (): ResumeNearestDeps => ({
  serverId: (socket) => runningServerId(socket),
  windowExists: (win, socket) => windowExists(win, socket),
  hasSession, splitPane, newWindow, newSession,
  fetchImpl: fetch,
  paneExists: (pane, socket) => paneExists(pane, socket),
  paneServerId: (pane, socket) => tmuxServerId(pane, socket),
  registry: createDefaultRegistry(),
  loadProfileLaunch,
  err: (l) => console.error(l),
});

export interface ResumeNearestOpts {
  idOrPrefix: string;
  hubUrl: string;
  agmuxBin: string;
  fallbackLaunch: LaunchSpec | null; // the [[remote]] launch, for rows started by hand
  out(line: string): void;
}

const PREFIX = "attach --resume-nearest";

// stdout carries exactly this one line; refuse coords the Mac could not parse.
function printCoords(c: PaneCoords, server: string | null, o: ResumeNearestOpts, err: (l: string) => void): number {
  const printed: PrintedCoords = { remote_tmux: { session: c.session, window: c.window, pane: c.pane, socket: c.socket, server } };
  const line = JSON.stringify(printed);
  if (!parsePrintedCoords(line)) { err(`${PREFIX}: unreportable tmux coords ${line}`); return 1; }
  o.out(line);
  return 0;
}

async function place(t: NearestTarget, a: { cmd: string[]; env: Record<string, string>; cwd?: string; windowName: string; socket: string | null }, deps: NearestDeps): Promise<PaneCoords> {
  const { cmd, env, cwd, windowName, socket } = a;
  if (t.kind === "split") return deps.splitPane({ targetPane: t.window, cmd, env, cwd, socket, detach: true });
  if (t.kind === "window") return deps.newWindow({ sessionName: t.session, windowName, cmd, env, cwd, socket, detach: true });
  return deps.newSession({ sessionName: t.name, windowName, cmd, env, cwd, socket });
}

// A live row is in place only if its pane still exists on the server it was
// recorded on. A restarted server can have a recreated session of the same
// name and reuse `@N`/`%N` for another agent (Review Focus 2).
async function stillInPlace(session: SessionRow, deps: ResumeNearestDeps): Promise<boolean> {
  if ((await decideAttach(session, deps.hasSession)) !== "attach" || !session.tmux_pane) return false;
  const socket = session.tmux_socket;
  if (session.tmux_server && (await deps.serverId(socket)) !== session.tmux_server) return false;
  return deps.paneExists(session.tmux_pane, socket);
}

async function loadRow(o: ResumeNearestOpts, deps: ResumeNearestDeps): Promise<
  { ok: true; session: SessionRow; turnCount: number } | { ok: false; code: number }
> {
  const listR = await deps.fetchImpl(`${o.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { deps.err(`hub error ${listR.status}`); return { ok: false, code: 1 }; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(o.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { deps.err(res.error); return { ok: false, code: 2 }; }
  const r = await deps.fetchImpl(`${o.hubUrl}/sessions/${res.id}`);
  if (!r.ok) { deps.err(`hub error ${r.status}`); return { ok: false, code: 1 }; }
  const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
  // Same rule as a local resume (attach.ts): no usage row = zero turns.
  return { ok: true, session, turnCount: usage?.turn_count ?? 0 };
}

export async function resumeNearestCmd(o: ResumeNearestOpts, deps: ResumeNearestDeps = defaultResumeNearestDeps()): Promise<number> {
  let loaded;
  try { loaded = await loadRow(o, deps); } catch (e) {
    deps.err(`${PREFIX}: hub unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!loaded.ok) return loaded.code;
  const { session, turnCount } = loaded;
  const id8 = session.session_id.slice(0, 8);
  if (session.remote) {
    deps.err(`${PREFIX}: ${id8} is a remote session (host ${session.host}); resume it on its own host`);
    return 2;
  }

  try {
    // Still running where the row says: nothing to resume.
    if (await stillInPlace(session, deps)) {
      const c = { session: session.tmux_session!, window: session.tmux_window!, pane: session.tmux_pane!, socket: session.tmux_socket };
      return printCoords(c, session.tmux_server, o, deps.err);
    }

    const r = buildDirectRelaunch(session, {
      hubUrl: o.hubUrl, agmuxBin: o.agmuxBin, registry: deps.registry,
      // Only the agent's own env goes through tmux -e; the rest is the tmux server's.
      baseEnv: {}, turnCount,
      loadProfileLaunch: deps.loadProfileLaunch,
      fallbackLaunch: o.fallbackLaunch ?? undefined,
    });
    const env = { ...r.env };
    if (r.launch.profile) env[AGMUX_PROFILE_ENV] = r.launch.profile;

    const target = await pickNearest(session, deps);
    const coords = await place(target, { cmd: r.argv, env, cwd: r.cwd, windowName: `agmux:${id8}`, socket: session.tmux_socket }, deps);
    const server = await deps.paneServerId(coords.pane, coords.socket);
    const code = printCoords(coords, server, o, deps.err);
    if (code === 0) deps.err(`agmux: resumed ${id8} in ${coords.session}:${coords.window}.${coords.pane}`);
    return code;
  } catch (e) {
    deps.err(`${PREFIX}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export type ResumeNearestArgs = { kind: "ok"; fallbackLaunch: LaunchSpec | null } | { kind: "error"; message: string };

// Flags after `attach <id>`. This argv is a contract with the Mac (Task 10):
// only these flags are accepted, `--print-coords` is the only output mode.
export function parseResumeNearestArgs(args: string[]): ResumeNearestArgs {
  let printCoordsFlag = false;
  let fallbackLaunch: LaunchSpec | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--resume-nearest") continue;
    if (a === "--print-coords") { printCoordsFlag = true; continue; }
    if (a === "--fallback-launch") {
      fallbackLaunch = parseLaunchSpec(args[++i]);
      if (!fallbackLaunch) return { kind: "error", message: `${PREFIX}: --fallback-launch needs a launch JSON {"profile","command","args"}` };
      continue;
    }
    return { kind: "error", message: `${PREFIX}: unexpected argument ${JSON.stringify(a)}` };
  }
  if (!printCoordsFlag) return { kind: "error", message: `${PREFIX} requires --print-coords` };
  return { kind: "ok", fallbackLaunch };
}
