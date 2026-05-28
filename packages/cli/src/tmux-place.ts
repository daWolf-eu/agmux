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

const COORDS_FMT = "#{session_name}\t#{window_id}\t#{pane_id}";

export interface PaneCoords { session: string; window: string; pane: string; }

function parseCoords(out: string): PaneCoords {
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
  const out = (await $`tmux display-message -p ${COORDS_FMT}`.text()).trim();
  return parseCoords(out);
}

export async function hasSession(name: string): Promise<boolean> {
  try { await $`tmux has-session -t ${name}`.quiet(); return true; } catch { return false; }
}

export async function ensureSession(name: string): Promise<void> {
  if (await hasSession(name)) return;
  await $`tmux new-session -d -s ${name}`.quiet();
}

export async function splitPane(args: {
  targetPane: string;
  cmd: string[];
  env: Record<string, string>;
  detach: boolean;
}): Promise<PaneCoords> {
  // `tmux split-window -d` creates the new pane without making it the active
  // pane in the caller's client.
  const detachFlag = args.detach ? ["-d"] : [];
  const out = (
    await $`tmux split-window -t ${args.targetPane} ${detachFlag} ${eFlags(args.env)} -P -F ${COORDS_FMT} -- ${args.cmd}`.text()
  );
  return parseCoords(out);
}

export async function newWindow(args: {
  sessionName: string;
  windowName: string;
  cmd: string[];
  env: Record<string, string>;
  detach: boolean;
}): Promise<PaneCoords> {
  await ensureSession(args.sessionName);
  // `tmux new-window -d` creates the window but does not switch the client to it.
  // The trailing `:` on the target turns it into a session target (any window
  // index will do); without it tmux interprets `<session>` as "active window of
  // that session" and will refuse if its index is already taken.
  const detachFlag = args.detach ? ["-d"] : [];
  const target = `${args.sessionName}:`;
  const out = (
    await $`tmux new-window -t ${target} -n ${args.windowName} ${detachFlag} ${eFlags(args.env)} -P -F ${COORDS_FMT} -- ${args.cmd}`.text()
  );
  return parseCoords(out);
}

export async function newSession(args: {
  sessionName: string;
  windowName: string;
  cmd: string[];
  env: Record<string, string>;
}): Promise<PaneCoords> {
  if (await hasSession(args.sessionName)) {
    throw new Error(`tmux session already exists: ${args.sessionName}`);
  }
  // `tmux new-session -d` returns coords via -P -F just like new-window.
  const out = (
    await $`tmux new-session -d -s ${args.sessionName} -n ${args.windowName} ${eFlags(args.env)} -P -F ${COORDS_FMT} -- ${args.cmd}`.text()
  );
  return parseCoords(out);
}

// Move the caller's tmux client to the given target. Used after non-detached
// new-session creation, since `new-session -d` doesn't switch on its own.
export async function switchClient(target: string): Promise<void> {
  await $`tmux switch-client -t ${target}`.quiet();
}
