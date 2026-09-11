import * as path from "node:path";

// Shared primitives for the statusline cache file: written atomically by
// `agmux notifyd` and read by `agmux statusline`/`agmux statusline --check`.
// Kept in their own module (rather than split across notifyd.ts and
// statusline-cmd.ts) so neither of those files needs to import the other.

export const CACHE_REL_PATH = path.join("agmux", "statusline");

export function cachePath(env: Record<string, string | undefined>): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, CACHE_REL_PATH);
  return path.join(env.HOME ?? "/tmp", ".cache", CACHE_REL_PATH);
}

export function staleMarker(text: string): string {
  return `#[fg=#6c7086]agmux: ${text}#[default]`;
}

export function heartbeatPath(file: string): string {
  return `${file}.heartbeat`;
}

// Poll interval used both as notifyd's default subscribe cadence and as the
// basis for statusline --check's staleness judgement — a single source so the
// two can't silently drift apart.
export const DEFAULT_POLL_INTERVAL_MS = 1000;

// A stale heartbeat means the daemon died while its last rendered line stayed on
// disk — without this, tmux would keep painting confident, frozen state. Ten
// missed ticks is the threshold: generous enough to survive a slow poll, short
// enough to notice a dead daemon.
export function isStale(heartbeat: string | null, now: number, intervalMs: number): boolean {
  if (!heartbeat) return true;
  const t = Date.parse(heartbeat);
  if (Number.isNaN(t)) return true;
  return now - t > Math.max(intervalMs * 10, 10000);
}
