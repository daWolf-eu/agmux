import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { SessionRow } from "@agmux/protocol";
import { PollingSessionFeed, formatStatusLine, createDetectState, primeDetectState, detectNotifications } from "@agmux/tui";
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
  setIntervalImpl?: typeof setInterval;   // test seam for the daemon tick timer
  clearIntervalImpl?: typeof clearInterval;
  now?: () => number;   // test seam for the debounce clock
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
  // Two independent pieces of dedup state, both caller-owned and created once
  // for the daemon's lifetime, right next to each other: DetectState dedups
  // which transitions have already fired, `warned` dedups which "notifier
  // missing/failing" log lines have already been printed. Neither is
  // module-level — see the comment on SinkDeps.warned in sinks.ts.
  const detectState = createDetectState();
  const sinkDeps: SinkDeps = deps.sinkDeps ?? { run: realRun, capture: realCapture, which: whichSync, log, warned: new Set<string>() };
  const notify = deps.config.notify;

  const now = deps.now ?? Date.now;

  // The last rows the feed delivered, kept so the tick timer below can
  // re-evaluate them. `null` until the first update arrives.
  let lastRows: SessionRow[] | null = null;

  // detectNotifications is a pure function of (state, rows, now): with rows
  // unchanged it is idempotent — `fired` dedups an event that already went
  // out, and a pending entry keeps the `since` it was first given. That makes
  // it safe, and necessary, to call on a clock rather than only on change.
  const evaluate = (rows: SessionRow[]): void => {
    if (!notify.enabled) return;
    const events = detectNotifications(
      detectState, rows, { delayMs: notify.delayMs, triggers: notify.triggers }, now(),
    );
    for (const ev of events) {
      // dispatchNotification already swallows its own shell-out failures;
      // this catch is belt-and-braces so a notification bug can never
      // take the daemon down.
      dispatchNotification(ev, notify, sinkDeps).catch((e) => log(`agmux: notify dispatch failed: ${e}`));
    }
  };

  // Both things this timer does exist because the feed's onUpdate fires only
  // when rows actually changed (by design — see PollingSessionFeed), while
  // both of them are functions of elapsed time:
  //
  //  - The heartbeat must reflect daemon liveness, not session-change
  //    liveness, or a quiet steady state makes `statusline --check` falsely
  //    report a perfectly healthy daemon dead.
  //  - A debounced notification becomes due delayMs AFTER the change that
  //    armed it. Evaluating only inside onUpdate means the change that arms a
  //    wait is the last evaluation it ever gets, so the notification sits
  //    there until some unrelated session changes and drags it out late —
  //    the status line goes yellow immediately while the toast and sound
  //    arrive minutes later, attached to the wrong event.
  //
  // Re-evaluating stale rows while the hub is unreachable is deliberate: the
  // wait was real when we last saw it, and `fired` still caps it at one
  // notification per episode.
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  const tickTimer = setIntervalImpl(() => {
    beat();
    if (lastRows) evaluate(lastRows);
  }, intervalMs);

  const unsubscribe = feed.subscribe(
    (rows) => {
      writeLineAtomic(file, formatStatusLine(rows, { show, max, format }), deps.fs);
      beat();
      // The first observation is a baseline, not a wave of transitions: an
      // empty DetectState would otherwise read every already-waiting session
      // as brand new and announce the whole board on startup. The status line
      // written just above still shows all of them.
      if (lastRows === null) primeDetectState(detectState, rows);
      lastRows = rows;
      evaluate(rows);
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
      clearIntervalImpl(tickTimer);
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
