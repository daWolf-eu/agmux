import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { SessionRow } from "@agmux/protocol";
import { PollingSessionFeed, formatStatusLine, createDetectState, primeDetectState, detectNotifications } from "@agmux/tui";
import type { AttentionConfig } from "./attention-config.ts";
import { cachePath, staleMarker, heartbeatPath, DEFAULT_POLL_INTERVAL_MS } from "./statusline-cache.ts";
import { dispatchNotification, type SinkDeps } from "./sinks.ts";
import { acquireSingletonLock } from "@agmux/hub";
import type { IngestEnvelope } from "@agmux/protocol";
import { collectPaneSignals, createPaneSignalState, type PaneSignalDeps } from "./pane-signals.ts";

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

/**
 * Single-instance guard. Two daemons are not a harmless duplicate: each keeps
 * its own in-memory notified-set, so N daemons mean N notifications for one
 * event — and a daemon left behind by a `kill %1` that missed (job numbers are
 * per-shell) goes on serving pre-rebuild behaviour indefinitely.
 */
export interface NotifydLock {
  acquire: (lockPath: string) => { release: () => void } | null;
  holder: (lockPath: string) => number | null;
  kill: (pid: number) => void;
}

const realLock: NotifydLock = {
  acquire: (p) => acquireSingletonLock(p),
  holder: (p) => { try { return Number(fs.readFileSync(p, "utf8").trim()) || null; } catch { return null; } },
  kill: (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } },
};

export interface NotifydDeps {
  env: Record<string, string | undefined>;
  config: AttentionConfig;
  fs?: AtomicFsDeps;
  makeFeed?: (hubUrl: string, query: URLSearchParams) => { subscribe: (
    onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void) => () => void };
  onRows?: (rows: SessionRow[]) => void;   // sink hook; Task 12 attaches notifications here
  log?: (s: string) => void;
  sinkDeps?: SinkDeps;   // test seam; defaults to real tmux/notifier shell-outs
  lock?: NotifydLock;    // test seam; defaults to the hub's O_EXCL singleton lock
  setIntervalImpl?: typeof setInterval;   // test seam for the daemon tick timer
  clearIntervalImpl?: typeof clearInterval;
  now?: () => number;   // test seam for the debounce clock
  // tmux-derived attention signals (pane titles of native sessions, seen when a
  // turn ends under a focused client). Off unless provided — the bin wires the
  // real one; tests opt in with fakes. See pane-signals.ts.
  paneSignals?: Omit<PaneSignalDeps, "now"> & {
    post: (hubUrl: string, events: IngestEnvelope[]) => Promise<void>;
  };
}

export async function postIngest(hubUrl: string, events: IngestEnvelope[]): Promise<void> {
  try {
    await fetch(`${hubUrl}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(events),
    });
  } catch { /* hub down: the next tick re-observes */ }
}

export async function runNotifyd(
  opts: {
    hubUrl: string;                 // display / fallback
    // Re-resolved per poll so the daemon follows the hub across a restart.
    resolveHubUrl?: () => string | null | undefined;
    intervalMs?: number; stop?: AbortSignal; lockPath?: string; replace?: boolean;
  },
  deps: NotifydDeps,
): Promise<number> {
  const file = cachePath(deps.env);
  const { show, max, format, sort } = deps.config.statusline;
  const query = new URLSearchParams({ status: "open", sort, order: "desc" });
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const feed = deps.makeFeed
    ? deps.makeFeed(opts.hubUrl, query)
    : new PollingSessionFeed({ hubUrl: opts.resolveHubUrl ?? opts.hubUrl, query, intervalMs });

  const beat = () => writeLineAtomic(heartbeatPath(file), new Date().toISOString(), deps.fs);

  const log = deps.log ?? ((s: string) => { process.stderr.write(`${s}\n`); });

  // Acquire before anything else observable happens: a refused start must not
  // have written a status line or fired a notification first.
  let lockHandle: { release: () => void } | null = null;
  if (opts.lockPath) {
    const lock = deps.lock ?? realLock;
    lockHandle = lock.acquire(opts.lockPath);
    if (!lockHandle) {
      const holder = lock.holder(opts.lockPath);
      if (!opts.replace) {
        log(`agmux: notifyd is already running (pid ${holder ?? "unknown"}). ` +
            `Use 'agmux notifyd --replace' to restart it, or kill ${holder ?? "it"} first.`);
        return 1;
      }
      if (holder !== null) lock.kill(holder);
      // The incumbent releases on SIGTERM; give it a moment, then take over.
      for (let i = 0; i < 50 && !lockHandle; i++) {
        await new Promise((r) => setTimeout(r, 20));
        lockHandle = lock.acquire(opts.lockPath);
      }
      if (!lockHandle) {
        log(`agmux: notifyd ${holder ?? "incumbent"} did not exit; not starting.`);
        return 1;
      }
    }
  }
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
  // At most one pass in flight: a slow tmux must not stack up passes.
  const signalState = createPaneSignalState();
  let signalsBusy = false;
  const runPaneSignals = (rows: SessionRow[]): void => {
    const ps = deps.paneSignals;
    if (!ps || signalsBusy) return;
    signalsBusy = true;
    collectPaneSignals(signalState, rows, { ...ps, now })
      .then(async (events) => {
        if (events.length === 0) return;
        const hub = opts.resolveHubUrl?.() ?? opts.hubUrl;
        await ps.post(hub, events);
      })
      .catch((e) => log(`agmux: pane signals failed: ${e}`))
      .finally(() => { signalsBusy = false; });
  };

  const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  const tickTimer = setIntervalImpl(() => {
    beat();
    if (lastRows) { evaluate(lastRows); runPaneSignals(lastRows); }
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
      runPaneSignals(rows);
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
      lockHandle?.release();
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
