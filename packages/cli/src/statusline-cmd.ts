import type { SessionRow } from "@agmux/protocol";
import { formatStatusLine, nextShow, type ShowMode } from "@agmux/tui";
import type { AttentionConfig } from "./attention-config.ts";
import {
  cachePath, staleMarker, heartbeatPath, isStale, showPath, readShow, writeLineAtomic,
  DEFAULT_POLL_INTERVAL_MS, type AtomicFsDeps,
} from "./statusline-cache.ts";
import { resolveLineStyle, type TmuxStyle } from "./statusline-style.ts";

export interface StatuslineCmdDeps {
  fetchImpl: typeof fetch;
  out: (s: string) => void;
  config: AttentionConfig;
  env: Record<string, string | undefined>;
  readFile: (p: string) => string | null;
  fs?: AtomicFsDeps;
  // The @agmux-statusline-* tmux options (readTmuxStyle); none when absent.
  tmuxStyle?: () => Promise<TmuxStyle>;
}

// The line for `rows` with the current filter, config and tmux style.
async function renderLine(rows: SessionRow[], show: ShowMode, deps: StatuslineCmdDeps): Promise<string> {
  const tmux = deps.tmuxStyle ? await deps.tmuxStyle().catch(() => ({})) : {};
  const { format, style } = resolveLineStyle(deps.config.statusline, tmux);
  return formatStatusLine(rows, { show, max: deps.config.statusline.max, format, style });
}

// The filter chip's override, else `[statusline] show`.
function currentShow(deps: StatuslineCmdDeps): ShowMode {
  return readShow(deps.readFile(showPath(cachePath(deps.env)))) ?? deps.config.statusline.show;
}

async function fetchRows(hubUrl: string, deps: StatuslineCmdDeps): Promise<SessionRow[] | null> {
  const q = new URLSearchParams({ status: "open", sort: deps.config.statusline.sort, order: "desc" });
  const res = await deps.fetchImpl(`${hubUrl}/sessions?${q.toString()}`);
  if (!res.ok) return null;
  return ((await res.json()) as { sessions: SessionRow[] }).sessions;
}

// The filter chip: step the show mode along SHOW_CYCLE, save it, and repaint
// the cache now — notifyd only re-renders when a session changes, and reads the
// saved mode when it does. Never throws (runs from a tmux mouse binding).
export async function cycleShowCmd(
  step: 1 | -1, opts: { hubUrl: string }, deps: StatuslineCmdDeps,
): Promise<number> {
  const file = cachePath(deps.env);
  const show = nextShow(currentShow(deps), step);
  writeLineAtomic(showPath(file), show, deps.fs);
  try {
    const rows = await fetchRows(opts.hubUrl, deps);
    if (rows) writeLineAtomic(file, await renderLine(rows, show, deps), deps.fs);
  } catch { /* notifyd repaints on the next change */ }
  return 0;
}

// Always exits 0: this runs inside tmux's status-format expansion, where a
// non-zero exit or a thrown error just paints garbage into the user's status bar.
export async function statuslineCmd(
  opts: { hubUrl: string; check?: boolean; printConfig?: boolean },
  deps: StatuslineCmdDeps,
): Promise<number> {
  // --print-config lets agmux.tmux (the shell plugin) ask the binary for the
  // resolved [statusline] config-file defaults at plugin load, so it can fall
  // back to them when the user hasn't set the corresponding @agmux-* tmux
  // option. Never touches the hub, and the caller (bin/agmux.ts) always hands
  // us a config — falling back to the built-in defaults itself on any load
  // error — so this branch can never throw.
  if (opts.printConfig) {
    deps.out(`enabled=${deps.config.statusline.enabled}`);
    deps.out(`position=${deps.config.statusline.position}`);
    return 0;
  }
  // --check renders from the cache file rather than the hub, so tmux can show
  // that the daemon died instead of silently painting its last frozen line.
  if (opts.check) {
    try {
      const file = cachePath(deps.env);
      if (isStale(deps.readFile(heartbeatPath(file)), Date.now(), DEFAULT_POLL_INTERVAL_MS)) {
        deps.out(staleMarker("stale"));
      } else {
        deps.out(deps.readFile(file) ?? "");
      }
    } catch {
      deps.out(staleMarker("stale"));
    }
    return 0;
  }
  try {
    const sessions = await fetchRows(opts.hubUrl, deps);
    if (!sessions) { deps.out(staleMarker("hub down")); return 0; }
    deps.out(await renderLine(sessions, currentShow(deps), deps));
  } catch {
    deps.out(staleMarker("hub down"));
  }
  return 0;
}
