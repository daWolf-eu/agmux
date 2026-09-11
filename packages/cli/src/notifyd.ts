import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { SessionRow } from "@agmux/protocol";
import { PollingSessionFeed, formatStatusLine, createDetectState, detectNotifications } from "@agmux/tui";
import type { AttentionConfig } from "./attention-config.ts";
import { cachePath, staleMarker, heartbeatPath, DEFAULT_POLL_INTERVAL_MS } from "./statusline-cache.ts";
import { dispatchNotification, type SinkDeps } from "./sinks.ts";

// No shell involved (execFile, not exec), and `which` is a plain PATH scan —
// no subprocess at all — so there is nothing here that can execute untrusted
// input or invoke a shell.
function whichSync(bin: string): boolean {
  if (path.isAbsolute(bin)) {
    try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch { return false; }
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

function realRun(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => { if (err) reject(err); else resolve(0); });
  });
}

function realCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  });
}

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

export interface NotifydDeps {
  env: Record<string, string | undefined>;
  config: AttentionConfig;
  fs?: AtomicFsDeps;
  makeFeed?: (hubUrl: string, query: URLSearchParams) => { subscribe: (
    onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void) => () => void };
  onRows?: (rows: SessionRow[]) => void;   // sink hook; Task 12 attaches notifications here
  log?: (s: string) => void;
  sinkDeps?: SinkDeps;   // test seam; defaults to real tmux/notifier shell-outs
}

export async function runNotifyd(
  opts: { hubUrl: string; intervalMs?: number; stop?: AbortSignal },
  deps: NotifydDeps,
): Promise<number> {
  const file = cachePath(deps.env);
  const { show, max, format, sort } = deps.config.statusline;
  const query = new URLSearchParams({ status: "open", sort, order: "desc" });
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const feed = deps.makeFeed
    ? deps.makeFeed(opts.hubUrl, query)
    : new PollingSessionFeed({ hubUrl: opts.hubUrl, query, intervalMs });

  const beat = () => writeLineAtomic(heartbeatPath(file), new Date().toISOString(), deps.fs);

  const log = deps.log ?? ((s: string) => { process.stderr.write(`${s}\n`); });
  const sinkDeps: SinkDeps = deps.sinkDeps ?? { run: realRun, capture: realCapture, which: whichSync, log };
  const detectState = createDetectState();
  const notify = deps.config.notify;

  const unsubscribe = feed.subscribe(
    (rows) => {
      writeLineAtomic(file, formatStatusLine(rows, { show, max, format }), deps.fs);
      beat();
      if (notify.enabled) {
        const events = detectNotifications(
          detectState, rows, { delayMs: notify.delayMs, triggers: notify.triggers }, Date.now(),
        );
        for (const ev of events) {
          // dispatchNotification already swallows its own shell-out failures;
          // this catch is belt-and-braces so a notification bug can never
          // take the daemon down.
          dispatchNotification(ev, notify, sinkDeps).catch((e) => log(`agmux: notify dispatch failed: ${e}`));
        }
      }
      deps.onRows?.(rows);
    },
    () => { writeLineAtomic(file, staleMarker("hub down"), deps.fs); beat(); },
  );

  // SIGINT/SIGTERM registered with `once` (auto-remove on fire) and explicitly
  // removed on any other shutdown path (abort signal), so repeated calls in a
  // single process — as in tests — never leak listeners or trip Node's
  // MaxListenersExceededWarning.
  await new Promise<void>((resolve) => {
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      unsubscribe();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      opts.stop?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onSignal = () => stop();
    const onAbort = () => stop();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    if (opts.stop) {
      if (opts.stop.aborted) stop();
      else opts.stop.addEventListener("abort", onAbort, { once: true });
    }
  });
  return 0;
}
