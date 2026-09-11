import * as path from "node:path";
import type { SessionRow } from "@agmux/protocol";
import { formatStatusLine } from "@agmux/tui";
import type { AttentionConfig } from "./attention-config.ts";
import { heartbeatPath, isStale } from "./notifyd.ts";

export interface StatuslineCmdDeps {
  fetchImpl: typeof fetch;
  out: (s: string) => void;
  config: AttentionConfig;
  env: Record<string, string | undefined>;
  readFile: (p: string) => string | null;
}

export const CACHE_REL_PATH = path.join("agmux", "statusline");

export function cachePath(env: Record<string, string | undefined>): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, CACHE_REL_PATH);
  return path.join(env.HOME ?? "/tmp", ".cache", CACHE_REL_PATH);
}

export function staleMarker(text: string): string {
  return `#[fg=#6c7086]agmux: ${text}#[default]`;
}

// Always exits 0: this runs inside tmux's status-format expansion, where a
// non-zero exit or a thrown error just paints garbage into the user's status bar.
export async function statuslineCmd(
  opts: { hubUrl: string; check?: boolean },
  deps: StatuslineCmdDeps,
): Promise<number> {
  const { show, max, format, sort } = deps.config.statusline;
  // --check renders from the cache file rather than the hub, so tmux can show
  // that the daemon died instead of silently painting its last frozen line.
  if (opts.check) {
    try {
      const file = cachePath(deps.env);
      if (isStale(deps.readFile(heartbeatPath(file)), Date.now(), 1000)) {
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
    const q = new URLSearchParams({ status: "open", sort, order: "desc" });
    const res = await deps.fetchImpl(`${opts.hubUrl}/sessions?${q.toString()}`);
    if (!res.ok) { deps.out(staleMarker("hub down")); return 0; }
    const { sessions } = (await res.json()) as { sessions: SessionRow[] };
    deps.out(formatStatusLine(sessions, { show, max, format }));
  } catch {
    deps.out(staleMarker("hub down"));
  }
  return 0;
}
