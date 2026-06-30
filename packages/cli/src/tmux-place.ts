// Tmux placement helpers used by `agmux run` when the user picks a
// --new-pane / --new-window / --new-session placement. The CLI does the tmux
// dance up front; the wrapper inside the resulting pane just sees TMUX set and
// runs the agent inline.
//
// `detach: true` means "place the agent but keep the caller's current focus."
// For new-pane / new-window this is tmux's own `-d` flag; for new-session we
// already create the session detached (-d) and just skip the post-create
// switch-client.
import { $ } from "bun";
import { tmuxSocketFromEnv, tmuxSocketArgs } from "@agmux/protocol";

const COORDS_FMT = "#{session_name}\t#{window_id}\t#{pane_id}";

export interface PaneCoords { session: string; window: string; pane: string; socket: string | null; }

function parseCoords(out: string): Omit<PaneCoords, "socket"> {
  const trimmed = out.trim();
  const [session, window, pane] = trimmed.split("\t");
  if (!session || !window || !pane) {
    throw new Error(`tmux: unparseable coords output: ${JSON.stringify(trimmed)}`);
  }
  return { session, window, pane };
}

function eFlags(env: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    out.push("-e", `${k}=${v}`);
  }
  return out;
}

export async function readCurrentPane(): Promise<PaneCoords | null> {
  if (!process.env.TMUX) return null;
  const socket = tmuxSocketFromEnv(process.env.TMUX);
  const out = (await $`tmux ${tmuxSocketArgs(socket)} display-message -p ${COORDS_FMT}`.text()).trim();
  return { ...parseCoords(out), socket };
}

export async function hasSession(name: string, socket: string | null = null): Promise<boolean> {
  try { await $`tmux ${tmuxSocketArgs(socket)} has-session -t ${name}`.quiet(); return true; } catch { return false; }
}

export async function ensureSession(name: string, socket: string | null = null): Promise<void> {
  if (await hasSession(name, socket)) return;
  await $`tmux ${tmuxSocketArgs(socket)} new-session -d -s ${name}`.quiet();
}

export async function splitPane(args: {
  targetPane: string;
  cmd: string[];
  env: Record<string, string>;
  detach: boolean;
  cwd?: string;
  socket?: string | null;
}): Promise<PaneCoords> {
  // `tmux split-window -d` creates the new pane without making it the active
  // pane in the caller's client.
  const detachFlag = args.detach ? ["-d"] : [];
  const cwdFlag = args.cwd ? ["-c", args.cwd] : [];
  const out = (
    await $`tmux ${tmuxSocketArgs(args.socket)} split-window -t ${args.targetPane} ${detachFlag} ${cwdFlag} ${eFlags(args.env)} -P -F ${COORDS_FMT} -- ${args.cmd}`.text()
  );
  return { ...parseCoords(out), socket: args.socket ?? null };
}

export async function newWindow(args: {
  sessionName: string;
  windowName: string;
  cmd: string[];
  env: Record<string, string>;
  detach: boolean;
  cwd?: string;
  socket?: string | null;
}): Promise<PaneCoords> {
  await ensureSession(args.sessionName, args.socket);
  // `tmux new-window -d` creates the window but does not switch the client to it.
  // The trailing `:` on the target turns it into a session target (any window
  // index will do); without it tmux interprets `<session>` as "active window of
  // that session" and will refuse if its index is already taken.
  const detachFlag = args.detach ? ["-d"] : [];
  const cwdFlag = args.cwd ? ["-c", args.cwd] : [];
  const target = `${args.sessionName}:`;
  const out = (
    await $`tmux ${tmuxSocketArgs(args.socket)} new-window -t ${target} -n ${args.windowName} ${detachFlag} ${cwdFlag} ${eFlags(args.env)} -P -F ${COORDS_FMT} -- ${args.cmd}`.text()
  );
  return { ...parseCoords(out), socket: args.socket ?? null };
}

export async function newSession(args: {
  sessionName: string;
  windowName: string;
  cmd: string[];
  env: Record<string, string>;
  cwd?: string;
  socket?: string | null;
}): Promise<PaneCoords> {
  if (await hasSession(args.sessionName, args.socket)) {
    throw new Error(`tmux session already exists: ${args.sessionName}`);
  }
  // `tmux new-session -d` returns coords via -P -F just like new-window.
  const cwdFlag = args.cwd ? ["-c", args.cwd] : [];
  const out = (
    await $`tmux ${tmuxSocketArgs(args.socket)} new-session -d -s ${args.sessionName} -n ${args.windowName} ${cwdFlag} ${eFlags(args.env)} -P -F ${COORDS_FMT} -- ${args.cmd}`.text()
  );
  return { ...parseCoords(out), socket: args.socket ?? null };
}

// Move the caller's tmux client to the given target. Used after non-detached
// new-session creation, since `new-session -d` doesn't switch on its own.
export async function switchClient(target: string, socket: string | null = null): Promise<void> {
  await $`tmux ${tmuxSocketArgs(socket)} switch-client -t ${target}`.quiet();
}

// Best-effort lookup of a pane's session+window for session.registered enrichment.
// Injectable exec keeps it unit-testable; the default shells out to tmux. Returns
// null on any failure — callers must treat coords as optional.
export type TmuxExec = (args: string[]) => Promise<string>;

const defaultTmuxExec: TmuxExec = async (args) => {
  // Use Bun.spawn for dynamic args (Bun.$ requires static template literals).
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`tmux exit ${proc.exitCode}`);
  return out;
};

export async function resolvePaneCoords(
  paneId: string,
  exec: TmuxExec = defaultTmuxExec,
  socket: string | null = null,
): Promise<{ session: string; window: string } | null> {
  try {
    const out = await exec([...tmuxSocketArgs(socket), "display-message", "-p", "-t", paneId, "#{session_name}\t#{window_id}"]);
    const parts = out.trim().split("\t");
    const session = parts[0];
    const window = parts[1];
    if (!session || !window) return null;
    return { session, window };
  } catch {
    return null;
  }
}
