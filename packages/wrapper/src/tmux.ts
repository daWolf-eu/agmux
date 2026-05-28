import { $ } from "bun";

export interface TmuxCoords { session: string; window: string; pane: string; }

export async function readCurrentTmuxCoords(): Promise<TmuxCoords | null> {
  if (!process.env.TMUX) return null;
  // Use a JS string with real tab chars so tmux receives them as separators, not literal \t.
  const fmt = "#{session_name}\t#{window_id}\t#{pane_id}";
  const out = (await $`tmux display-message -p ${fmt}`.text()).trim();
  const [session, window, pane] = out.split("\t");
  if (!session || !window || !pane) return null;
  return { session, window, pane };
}

export async function ensureAgmuxSession(name = "agmux"): Promise<void> {
  // `tmux has-session` returns non-zero when missing; `bun $` throws — catch it.
  try {
    await $`tmux has-session -t ${name}`.quiet();
  } catch {
    await $`tmux new-session -d -s ${name}`.quiet();
  }
}

export async function newAgmuxWindow(
  sessionName: string,
  windowName: string,
  cmd: string[],
  env: Record<string, string> = {},
): Promise<TmuxCoords> {
  // Create the window, with the wrapper invocation as its initial command, and capture coords.
  // `-e KEY=VAL` (tmux >=3.0) sets env per-window so we don't depend on the session's
  // env snapshot (which is fixed at session-create time).
  const fmt = "#{session_name}\t#{window_id}\t#{pane_id}";
  const eFlags: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    eFlags.push("-e", `${k}=${v}`);
  }
  const out = (
    await $`tmux new-window -t ${sessionName} -n ${windowName} ${eFlags} -P -F ${fmt} -- ${cmd}`.text()
  ).trim();
  const [session, window, pane] = out.split("\t");
  if (!session || !window || !pane) throw new Error(`tmux new-window: unparseable output: ${out}`);
  return { session, window, pane };
}

export async function attachOrSwitch(sessionName: string, windowId: string): Promise<void> {
  if (process.env.TMUX) {
    await $`tmux switch-client -t ${sessionName}:${windowId}`.quiet();
  } else {
    // attach is blocking — let the caller decide whether to exec into it.
    await $`tmux attach -t ${sessionName} \\; select-window -t ${sessionName}:${windowId}`;
  }
}

export async function killWindow(sessionName: string, windowId: string): Promise<void> {
  try { await $`tmux kill-window -t ${sessionName}:${windowId}`.quiet(); } catch {}
}

export async function tmuxVersion(): Promise<string | null> {
  try {
    const v = (await $`tmux -V`.text()).trim();
    return v.replace(/^tmux\s+/, "");
  } catch { return null; }
}
