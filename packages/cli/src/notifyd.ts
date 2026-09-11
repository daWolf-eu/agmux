import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRow } from "@agmux/protocol";
import { PollingSessionFeed, formatStatusLine } from "@agmux/tui";
import type { AttentionConfig } from "./attention-config.ts";
import { cachePath, staleMarker } from "./statusline-cmd.ts";

export interface AtomicFsDeps {
  mkdir: (dir: string) => void;
  write: (file: string, text: string) => void;
  rename: (from: string, to: string) => void;
}

const realFs: AtomicFsDeps = {
  mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
  write: (f, t) => fs.writeFileSync(f, t),
  rename: (a, b) => fs.renameSync(a, b),
};

// Write temp-then-rename so a tmux client expanding #(cat ...) concurrently
// never reads a half-written line. Never throws: a cache-file problem must not
// take the daemon down.
export function writeLineAtomic(file: string, text: string, deps: AtomicFsDeps = realFs): void {
  try {
    deps.mkdir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    deps.write(tmp, text);
    deps.rename(tmp, file);
  } catch { /* best-effort */ }
}

export function heartbeatPath(file: string): string {
  return `${file}.heartbeat`;
}

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

export interface NotifydDeps {
  env: Record<string, string | undefined>;
  config: AttentionConfig;
  fs?: AtomicFsDeps;
  makeFeed?: (hubUrl: string, query: URLSearchParams) => { subscribe: (
    onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void) => () => void };
  onRows?: (rows: SessionRow[]) => void;   // sink hook; Task 12 attaches notifications here
  log?: (s: string) => void;
}

export async function runNotifyd(
  opts: { hubUrl: string; intervalMs?: number },
  deps: NotifydDeps,
): Promise<number> {
  const file = cachePath(deps.env);
  const { show, max, format, sort } = deps.config.statusline;
  const query = new URLSearchParams({ status: "open", sort, order: "desc" });

  const feed = deps.makeFeed
    ? deps.makeFeed(opts.hubUrl, query)
    : new PollingSessionFeed({ hubUrl: opts.hubUrl, query, intervalMs: opts.intervalMs ?? 1000 });

  const beat = () => writeLineAtomic(heartbeatPath(file), new Date().toISOString(), deps.fs);

  const unsubscribe = feed.subscribe(
    (rows) => {
      writeLineAtomic(file, formatStatusLine(rows, { show, max, format }), deps.fs);
      beat();
      deps.onRows?.(rows);
    },
    () => { writeLineAtomic(file, staleMarker("hub down"), deps.fs); beat(); },
  );

  await new Promise<void>((resolve) => {
    const stop = () => { unsubscribe(); resolve(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
