// Rex placements for `agmux run` and resume: the same shapes as tmux-place.ts,
// with Rex ids in PaneCoords (session = session id, window = window id, pane =
// block id, socket = the server endpoint).
//
// Rex has no per-pane env flag, so env goes through env(1) ahead of the
// hold-on-failure wrapper. Values are separate argv elements, never a shell string.
import type { SessionRow } from "@agmux/protocol";
import { defaultRexExec, readCurrentRexCoords, rexTarget, type RexExec } from "@agmux/wrapper";
import { holdOnFailure, withEnv, type PaneCoords } from "./tmux-place.ts";

const PLACE_TIMEOUT = "10s";

// A user's init.lua popup binding can pass ctx.block_id here: Rex doesn't expose
// which tiled block was focused under a float.
export const REX_ORIGIN_BLOCK_ENV = "AGMUX_REX_ORIGIN_BLOCK";

function parse(stdout: string): any {
  try { return JSON.parse(stdout); } catch { return null; }
}

async function place(exec: RexExec, socket: string | null, args: string[]): Promise<any> {
  const r = await exec([...rexTarget(socket, PLACE_TIMEOUT), ...args]);
  if (r.code !== 0) throw new Error(`rex ${args[0]}${args[0] === "window" ? " new" : ""} failed (exit ${r.code})`);
  const j = parse(r.stdout);
  if (!j) throw new Error(`rex ${args[0]}: unparseable output`);
  return j;
}

const placed = (env: Record<string, string>, cmd: string[]): string[] => withEnv(env, holdOnFailure(cmd));

async function windowOf(exec: RexExec, socket: string | null, session: string, block: string): Promise<string> {
  const r = await exec([...rexTarget(socket), "block", "inspect", block, "-s", session, "--json"]);
  const w = r.code === 0 ? parse(r.stdout)?.block?.window_id : null;
  return typeof w === "string" ? w : "";
}

export async function rexCurrentPane(
  env: Record<string, string | undefined>,
  popup: boolean,
  exec: RexExec = defaultRexExec,
): Promise<PaneCoords | null> {
  try {
    const session = env.REX_SESSION;
    const block = env.REX_BLOCK;
    if (!session || !block) return null;
    const socket = env.REX_SERVER || null;
    if (!popup) {
      const c = await readCurrentRexCoords(env, exec);
      return c ? { session: c.session, window: c.window ?? "", pane: c.pane, socket: c.socket } : null;
    }
    // In a popup REX_BLOCK is the float, which closes with the dash.
    const origin = env[REX_ORIGIN_BLOCK_ENV];
    if (origin) {
      const window = await windowOf(exec, socket, session, origin);
      if (window) return { session, window, pane: origin, socket };
    }
    const window = await windowOf(exec, socket, session, block);
    if (!window) return null;
    const g = rexTarget(socket);
    const ins = await exec([...g, "session", "inspect", session, "--json"]);
    const j = ins.code === 0 ? parse(ins.stdout) : null;
    const win = Array.isArray(j?.windows) ? j.windows.find((w: any) => w?.window_id === window) : null;
    const tiled = Array.isArray(win?.layers) ? win.layers.find((l: any) => l?.kind === "tiled") : null;
    const first = tiled?.blocks?.[0]?.block_id;
    return typeof first === "string" ? { session, window, pane: first, socket } : null;
  } catch {
    return null;
  }
}

export async function rexHasSession(
  name: string,
  socket: string | null = null,
  exec: RexExec = defaultRexExec,
): Promise<boolean> {
  return (await rexResolveSession(name, socket, exec)) !== null;
}

// A full session id or an exact label → the session id; null when absent or unreachable.
async function rexResolveSession(name: string, socket: string | null, exec: RexExec): Promise<string | null> {
  const r = await exec([...rexTarget(socket), "ls", "--json"]);
  const list = r.code === 0 ? parse(r.stdout)?.sessions : null;
  if (!Array.isArray(list)) return null;
  const hit = list.find((s: any) => s?.session_id === name) ?? list.find((s: any) => s?.label === name);
  return typeof hit?.session_id === "string" ? hit.session_id : null;
}

export async function rexSplitPane(args: {
  targetPane: string;
  cmd: string[];
  env: Record<string, string>;
  detach: boolean;
  cwd?: string;
  socket?: string | null;
  session?: string;
  label?: string;
}, exec: RexExec = defaultRexExec): Promise<PaneCoords> {
  const socket = args.socket ?? null;
  const session = args.session ?? process.env.REX_SESSION;
  if (!session) throw new Error("rex split: no session for the anchor block");
  const j = await place(exec, socket, [
    "split", "-s", session, "-b", args.targetPane, "--json",
    ...(args.detach ? ["--focus=false"] : []),
    ...(args.cwd ? ["-c", args.cwd] : []),
    ...(args.label ? ["--label", args.label] : []),
    "--", ...placed(args.env, args.cmd),
  ]);
  const pane = j.block_ids?.[0];
  if (typeof pane !== "string") throw new Error("rex split: no block id in output");
  return { session, window: await windowOf(exec, socket, session, pane), pane, socket };
}

export async function rexNewWindow(args: {
  sessionName: string;
  windowName: string;
  cmd: string[];
  env: Record<string, string>;
  detach: boolean;
  cwd?: string;
  socket?: string | null;
}, exec: RexExec = defaultRexExec): Promise<PaneCoords> {
  const socket = args.socket ?? null;
  // The current session arrives as an id; AGMUX_TMUX_SESSION arrives as a label.
  const session = await rexResolveSession(args.sessionName, socket, exec);
  if (!session) {
    return rexNewSession({
      sessionName: args.sessionName, windowName: args.windowName, cmd: args.cmd, env: args.env,
      cwd: args.cwd, socket,
    }, exec);
  }
  const j = await place(exec, socket, [
    "window", "new", "-s", session, args.windowName, "--json",
    ...(args.detach ? ["--focus=false"] : []),
    ...(args.cwd ? ["-c", args.cwd] : []),
    "--", ...placed(args.env, args.cmd),
  ]);
  const window = j.window_id;
  const pane = j.block_ids?.[0];
  if (typeof window !== "string" || typeof pane !== "string") throw new Error("rex window new: no ids in output");
  return { session, window, pane, socket };
}

export async function rexNewSession(args: {
  sessionName: string;
  windowName: string;
  cmd: string[];
  env: Record<string, string>;
  cwd?: string;
  socket?: string | null;
  label?: string; // set on the first block (`rex new` has no label flag)
}, exec: RexExec = defaultRexExec): Promise<PaneCoords> {
  const socket = args.socket ?? null;
  if (await rexHasSession(args.sessionName, socket, exec)) {
    throw new Error(`rex session already exists: ${args.sessionName}`);
  }
  const j = await place(exec, socket, [
    "new", args.sessionName, "--window", args.windowName, "--json",
    ...(args.cwd ? ["-c", args.cwd] : []),
    "--", ...placed(args.env, args.cmd),
  ]);
  const win = j.initial_windows?.[0];
  const session = j.session_id;
  const pane = win?.block_ids?.[0];
  if (typeof session !== "string" || typeof win?.window_id !== "string" || typeof pane !== "string") {
    throw new Error("rex new: no ids in output");
  }
  // The block is already running: a failed rename only loses the dedup label.
  if (args.label) await exec([...rexTarget(socket), "block", "rename", pane, args.label, "-s", session]).catch(() => null);
  return { session, window: win.window_id, pane, socket };
}

export type Presence = "present" | "gone" | "unreachable";

// Exit 3 is the only proof a block is gone: 4 (server down), a timeout or a
// missing binary may leave the agent running. Likewise a row with nothing to ask about.
export async function rexPresence(
  row: Pick<SessionRow, "tmux_session" | "tmux_pane" | "tmux_socket">,
  exec: RexExec = defaultRexExec,
): Promise<Presence> {
  if (!row.tmux_session || !row.tmux_pane) return "unreachable";
  const r = await exec([...rexTarget(row.tmux_socket), "block", "inspect", row.tmux_pane, "-s", row.tmux_session, "--json"]);
  return r.code === 0 ? "present" : r.code === 3 ? "gone" : "unreachable";
}

export interface RexCallerBlock { block: string; server: string | null }

// The apps connected to a server; null when it can't be asked. `client ls` also
// lists CLI clients and connections with no kind. Rex says to treat an unknown
// connection_state as connected; "lost" has dropped and may never come back.
async function connectedApps(server: string | null, exec: RexExec): Promise<string[] | null> {
  const r = await exec([...rexTarget(server), "client", "ls", "--json"]);
  const list = r.code === 0 ? parse(r.stdout)?.clients : null;
  if (!Array.isArray(list)) return null;
  return list
    .filter((c: any) => c?.info?.kind === "app" && c.connection_state !== "lost" && typeof c.client_id === "string")
    .map((c: any) => c.client_id);
}

// The app showing the caller's block, when the row is on the caller's server.
// An owner is only trusted if it's a connected app: it can be a CLI client that
// has already gone (Task 1). Otherwise the sole app, or nobody.
async function chooseApp(
  apps: string[],
  callerBlock: RexCallerBlock | null,
  rowServer: string | null,
  exec: RexExec,
): Promise<string | null> {
  if (callerBlock && callerBlock.server === rowServer) {
    const r = await exec([...rexTarget(rowServer), "block", "inspect", callerBlock.block, "--json"]);
    const owner = r.code === 0 ? parse(r.stdout)?.block?.owner : null;
    if (apps.includes(owner)) return owner;
  }
  return apps.length === 1 ? apps[0]! : null;
}

// callerBlock in a popup is the tiled block under the float, which may have no owner itself.
export async function pickClient(
  callerBlock: RexCallerBlock | null,
  rowServer: string | null,
  exec: RexExec = defaultRexExec,
): Promise<string | null> {
  const apps = await connectedApps(rowServer, exec);
  return apps ? chooseApp(apps, callerBlock, rowServer, exec) : null;
}

export type RexFocusResult = "selected" | "focused-only" | "no-app";

// focus_block alone doesn't move the app between sessions, so session.select
// follows. Every call goes to the row's own server. In a popup this runs while
// the float is still up: Rex doesn't restore focus when it closes, but focus set
// from inside it sticks (Task 1).
export async function rexFocus(
  row: { session: string; window: string | null; pane: string; socket: string | null },
  caller: RexCallerBlock | null,
  exec: RexExec = defaultRexExec,
): Promise<RexFocusResult> {
  const g = rexTarget(row.socket, PLACE_TIMEOUT);
  const args = JSON.stringify({ session_id: row.session, block_id: row.pane });
  const f = await exec([...g, "api", "call", "-s", row.session, "session.focus_block", args]);
  if (f.code !== 0) throw new Error(`rex focus failed (exit ${f.code})`);
  const apps = await connectedApps(row.socket, exec);
  if (!apps) throw new Error("rex client ls failed");
  if (apps.length === 0) return "no-app";
  const client = await chooseApp(apps, caller, row.socket, exec);
  if (!client) return "focused-only";
  const s = await exec([
    // -s: a tmux pane inherits a stale REX_SESSION, which `do` would scope to.
    ...g, "-C", client, "do", "session.select", "-s", row.session, `session_id=${row.session}`,
    ...(row.window ? [`window_id=${row.window}`] : []),
  ]);
  if (s.code !== 0) throw new Error(`rex session.select failed (exit ${s.code})`);
  return "selected";
}

// `target` is "<session id>:<window id>", as the callers build it. A placement
// has already opened the tab, so an app that can't be switched isn't a failure.
export async function rexSwitchClient(
  target: string,
  socket: string | null = null,
  caller: RexCallerBlock | null = null,
  exec: RexExec = defaultRexExec,
): Promise<void> {
  const m = /^(session:[^:]+):(window:.+)$/.exec(target);
  if (!m) throw new Error(`rex focus: unparseable target ${JSON.stringify(target)}`);
  const session = m[1]!;
  const window = m[2]!;
  const ins = await exec([...rexTarget(socket), "session", "inspect", session, "--json"]);
  const windows = ins.code === 0 ? parse(ins.stdout)?.windows : null;
  const pane = Array.isArray(windows) ? windows.find((w: any) => w?.window_id === window)?.focused_block_id : null;
  if (typeof pane !== "string") throw new Error(`rex focus: no block in ${window}`);
  await rexFocus({ session, window, pane, socket }, caller, exec);
}

// A new tab (window) in `session` whose block carries `label`, so it can be found again.
export async function rexNewLabelledTab(a: {
  session: string;
  label: string;
  cmd: string[];
  env: Record<string, string>;
  socket: string | null;
}, exec: RexExec = defaultRexExec): Promise<PaneCoords> {
  const j = await place(exec, a.socket, [
    "run", "-s", a.session, "--label", a.label, "--json", "--", ...withEnv(a.env, a.cmd),
  ]);
  const window = j.window_id;
  const pane = j.block_ids?.[0];
  if (typeof window !== "string" || typeof pane !== "string") throw new Error("rex run: no ids in output");
  return { session: a.session, window, pane, socket: a.socket };
}

export async function findLabelledBlock(
  session: string,
  label: string,
  socket: string | null,
  exec: RexExec = defaultRexExec,
): Promise<string | null> {
  const r = await exec([...rexTarget(socket), "block", "ls", "-s", session, "--json"]);
  const blocks = r.code === 0 ? parse(r.stdout)?.blocks : null;
  if (!Array.isArray(blocks)) return null;
  const hit = blocks.find((b: any) => b?.label === label);
  return typeof hit?.block_id === "string" ? hit.block_id : null;
}
