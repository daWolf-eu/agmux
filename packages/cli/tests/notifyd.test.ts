import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionRow } from "@agmux/protocol";
import { writeLineAtomic, runNotifyd, type NotifydDeps } from "../src/notifyd.ts";
import { heartbeatPath } from "../src/statusline-cache.ts";
import { loadAttentionConfig } from "../src/attention-config.ts";

test("writes via a temp file then renames, so a reader never sees a partial line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-sl-"));
  const target = path.join(dir, "nested", "statusline");
  const seen: string[] = [];
  writeLineAtomic(target, "hello", {
    mkdir: (d) => { seen.push(`mkdir:${d}`); fs.mkdirSync(d, { recursive: true }); },
    write: (f, t) => { seen.push(`write:${path.basename(f)}`); fs.writeFileSync(f, t); },
    rename: (a, b) => { seen.push("rename"); fs.renameSync(a, b); },
  });
  expect(seen[0]).toContain("mkdir:");
  expect(seen[1]).toContain("write:statusline.");   // temp sibling, not the target
  expect(seen[2]).toBe("rename");
  expect(fs.readFileSync(target, "utf8")).toBe("hello");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a write failure is swallowed — the daemon must not die over a cache file", () => {
  expect(() => writeLineAtomic("/nope/x", "hi", {
    mkdir: () => { throw new Error("EACCES"); },
    write: () => {}, rename: () => {},
  })).not.toThrow();
});

// --- runNotifyd -------------------------------------------------------

const row: SessionRow = {
  session_id: "agx-1", agent_kind: "claude", profile: null, native_session_id: null,
  command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
  tmux_session: "work", tmux_window: "@2", tmux_socket: null, tmux_pane: "%7",
  host: "h", project: null, parent_session_id: null, start_ts: "2026-09-11T10:00:00.000Z",
  last_heartbeat_ts: null, end_ts: null, exit_code: null, signal: null,
  status: "running", origin: "native",
};

function memFsDeps(): { fs: NonNullable<NotifydDeps["fs"]>; files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    fs: {
      mkdir: () => {},
      write: (f, t) => { files[f] = t; },
      rename: (a, b) => { files[b] = files[a]!; delete files[a]; },
    },
  };
}

function baseDeps(over: Partial<NotifydDeps> = {}): NotifydDeps {
  return {
    env: { XDG_RUNTIME_DIR: "/run/u" },
    config: loadAttentionConfig(""),
    ...over,
  };
}

test("a feed update writes the rendered line and the heartbeat", async () => {
  const { fs: fsDeps, files } = memFsDeps();
  const ac = new AbortController();
  let capturedOnUpdate: ((rows: SessionRow[]) => void) | undefined;
  const unsubscribe = () => {};

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      makeFeed: () => ({
        subscribe: (onUpdate) => { capturedOnUpdate = onUpdate; return unsubscribe; },
      }),
    }),
  );

  expect(capturedOnUpdate).toBeDefined();
  capturedOnUpdate!([row]);

  const cache = "/run/u/agmux/statusline";
  expect(files[cache]).toContain("work:%7");
  expect(files[heartbeatPath(cache)]).toBeTruthy();

  ac.abort();
  expect(await p).toBe(0);
});

test("the feed's onError path writes the hub-down marker", async () => {
  const { fs: fsDeps, files } = memFsDeps();
  const ac = new AbortController();
  let capturedOnError: ((e: Error) => void) | undefined;

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      makeFeed: () => ({
        subscribe: (_onUpdate, onError) => { capturedOnError = onError; return () => {}; },
      }),
    }),
  );

  expect(capturedOnError).toBeDefined();
  capturedOnError!(new Error("refused"));

  const cache = "/run/u/agmux/statusline";
  expect(files[cache]).toContain("hub down");
  expect(files[heartbeatPath(cache)]).toBeTruthy();

  ac.abort();
  expect(await p).toBe(0);
});

test("aborting the stop signal unsubscribes from the feed and resolves runNotifyd", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();
  let unsubscribed = false;

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      makeFeed: () => ({
        subscribe: () => () => { unsubscribed = true; },
      }),
    }),
  );

  expect(unsubscribed).toBe(false);
  ac.abort();
  const code = await p;
  expect(code).toBe(0);
  expect(unsubscribed).toBe(true);
});

// --- heartbeat timer (regression fence for "agmux: stale" while healthy) ---

// dispatchNotification is async; let its promise chain settle before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeTimer() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  const cleared: number[] = [];
  const setIntervalImpl = ((fn: () => void) => {
    const id = nextId++;
    pending.set(id, fn);
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalImpl = ((id: unknown) => {
    cleared.push(id as number);
    pending.delete(id as number);
  }) as typeof clearInterval;
  const advance = (n = 1) => { for (let i = 0; i < n; i++) for (const fn of pending.values()) fn(); };
  return { setIntervalImpl, clearIntervalImpl, advance, cleared, pendingCount: () => pending.size };
}

test("heartbeat is written on a fixed cadence even when the feed never updates", async () => {
  const { fs: fsDeps, files } = memFsDeps();
  const ac = new AbortController();
  const timer = fakeTimer();

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      makeFeed: () => ({ subscribe: () => () => {} }), // never calls onUpdate/onError
    }),
  );

  const cache = "/run/u/agmux/statusline";
  expect(files[heartbeatPath(cache)]).toBeUndefined();

  timer.advance();
  const first = files[heartbeatPath(cache)];
  expect(first).toBeTruthy();

  timer.advance();
  expect(files[heartbeatPath(cache)]).toBeTruthy();

  ac.abort();
  expect(await p).toBe(0);
});

test("heartbeat is still written when feed updates do occur", async () => {
  const { fs: fsDeps, files } = memFsDeps();
  const ac = new AbortController();
  const timer = fakeTimer();
  let capturedOnUpdate: ((rows: SessionRow[]) => void) | undefined;

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      makeFeed: () => ({
        subscribe: (onUpdate) => { capturedOnUpdate = onUpdate; return () => {}; },
      }),
    }),
  );

  const cache = "/run/u/agmux/statusline";
  capturedOnUpdate!([row]);
  expect(files[heartbeatPath(cache)]).toBeTruthy();

  timer.advance();
  expect(files[heartbeatPath(cache)]).toBeTruthy();

  ac.abort();
  expect(await p).toBe(0);
});

test("shutdown via AbortSignal clears the heartbeat interval and stops further writes", async () => {
  const { fs: fsDeps, files } = memFsDeps();
  const ac = new AbortController();
  const timer = fakeTimer();

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      makeFeed: () => ({ subscribe: () => () => {} }),
    }),
  );

  expect(timer.pendingCount()).toBe(1);
  timer.advance();
  const cache = "/run/u/agmux/statusline";
  const before = files[heartbeatPath(cache)];
  expect(before).toBeTruthy();

  ac.abort();
  await p;

  expect(timer.cleared.length).toBe(1);
  expect(timer.pendingCount()).toBe(0);

  // Advancing after shutdown must not write again (nothing left pending, but
  // guard against a regression where the handle isn't actually removed).
  timer.advance();
  expect(files[heartbeatPath(cache)]).toBe(before);
});

test("shutdown removes the SIGINT/SIGTERM listeners it added", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();

  const before = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      makeFeed: () => ({ subscribe: () => () => {} }),
    }),
  );

  // The daemon registered its own SIGINT/SIGTERM handlers while awaiting shutdown.
  expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
  expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);

  ac.abort();
  await p;

  expect(process.listenerCount("SIGINT")).toBe(before.sigint);
  expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
});

test("a debounced notification fires on the timer, without waiting for the next feed change", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();
  const timer = fakeTimer();
  let clock = 1_000_000;
  const fired: string[] = [];
  let capturedOnUpdate: ((rows: SessionRow[]) => void) | undefined;

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      now: () => clock,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      sinkDeps: {
        run: async (cmd, args) => { fired.push(`${cmd} ${args.join(" ")}`); return 0; },
        capture: async () => "",
        which: () => true,
        log: () => {},
        warned: new Set<string>(),
      },
      makeFeed: () => ({
        subscribe: (onUpdate) => { capturedOnUpdate = onUpdate; return () => {}; },
      }),
    }),
  );

  // Baseline: the session is running when the daemon comes up.
  capturedOnUpdate!([{ ...row, status: "running", activity_ts: "2026-09-12T10:00:00.000Z" }]);

  // Then it asks for permission. The feed reports that once and, because
  // nothing about it changes afterwards, never reports again.
  capturedOnUpdate!([{ ...row, status: "waiting", last_input_kind: "permission",
    activity_ts: "2026-09-12T10:05:00.000Z" }]);
  await flush();
  expect(fired).toEqual([]);   // still inside the debounce window

  // No further feed update — only time passing.
  clock += 10_000;
  timer.advance();
  await flush();
  expect(fired.length).toBeGreaterThan(0);

  // And it stays deduped across later ticks.
  const after = fired.length;
  clock += 10_000;
  timer.advance();
  await flush();
  expect(fired.length).toBe(after);

  ac.abort();
  expect(await p).toBe(0);
});

test("a restart does not announce sessions that were already waiting", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();
  const timer = fakeTimer();
  let clock = 1_000_000;
  const fired: string[] = [];
  let capturedOnUpdate: ((rows: SessionRow[]) => void) | undefined;

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      now: () => clock,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      sinkDeps: {
        run: async (cmd, args) => { fired.push(`${cmd} ${args.join(" ")}`); return 0; },
        capture: async () => "",
        which: () => true,
        log: () => {},
        warned: new Set<string>(),
      },
      makeFeed: () => ({
        subscribe: (onUpdate) => { capturedOnUpdate = onUpdate; return () => {}; },
      }),
    }),
  );

  // The board as a fresh daemon finds it: everything already wants attention.
  const board: SessionRow[] = [
    { ...row, session_id: "agx-1", status: "waiting", last_input_kind: "permission",
      attention_ts: "2026-09-12T09:00:00.000Z", activity_ts: "2026-09-12T09:00:00.000Z" },
    { ...row, session_id: "agx-2", status: "idle",
      attention_ts: "2026-09-12T09:00:00.000Z", activity_ts: "2026-09-12T09:00:00.000Z" },
    { ...row, session_id: "agx-3", status: "idle",
      attention_ts: "2026-09-12T09:00:00.000Z", activity_ts: "2026-09-12T09:00:00.000Z" },
  ];
  capturedOnUpdate!(board);
  clock += 60_000;
  timer.advance();
  await flush();
  expect(fired).toEqual([]);

  // But a genuine transition after startup still gets through. It has to move
  // attention_ts: a fresh activity_ts alone is just a tool call, which must stay
  // silent (see transitions.ts — that was the subagent notification-spam bug).
  capturedOnUpdate!([...board.slice(1),
    { ...board[0]!, attention_ts: "2026-09-12T09:30:00.000Z", activity_ts: "2026-09-12T09:30:00.000Z" }]);
  clock += 10_000;
  timer.advance();
  await flush();
  expect(fired.length).toBeGreaterThan(0);

  ac.abort();
  expect(await p).toBe(0);
});

// Regression: a subagent's tool calls stream tool.used into the PARENT session,
// bumping activity_ts while the row stays stale-`waiting` (nothing emits
// input.received, and Claude's Stop hook does not fire while a subagent runs).
// The daemon must announce that one permission prompt once, then stay silent for
// the whole run, no matter how much tool activity goes by.
test("a subagent's tool activity does not re-announce an unchanged wait", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();
  const timer = fakeTimer();
  let clock = 1_000_000;
  const fired: string[] = [];
  let capturedOnUpdate: ((rows: SessionRow[]) => void) | undefined;

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      now: () => clock,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      sinkDeps: {
        run: async (cmd, args) => { fired.push(`${cmd} ${args.join(" ")}`); return 0; },
        capture: async () => "",
        which: () => true,
        log: () => {},
        warned: new Set<string>(),
      },
      makeFeed: () => ({
        subscribe: (onUpdate) => { capturedOnUpdate = onUpdate; return () => {}; },
      }),
    }),
  );

  const waiting = (activity: string): SessionRow[] => [{
    ...row, session_id: "agx-1", status: "waiting", last_input_kind: "permission",
    attention_ts: "2026-09-12T09:00:00.000Z", activity_ts: activity,
  }];

  // The daemon starts with the session already running, so priming does not
  // silence it; the permission prompt then arrives and is announced once.
  capturedOnUpdate!([{ ...row, session_id: "agx-1", status: "running" }]);
  timer.advance();
  await flush();
  capturedOnUpdate!(waiting("2026-09-12T09:00:00.000Z"));
  clock += 60_000;
  timer.advance();
  await flush();
  const afterFirst = fired.length;
  expect(afterFirst).toBeGreaterThan(0);

  // Now the subagent runs: a tool call every 10s, each a new activity_ts, every
  // gap far wider than the debounce. None of it is news.
  for (const min of ["09:01", "09:02", "09:03", "09:04", "09:05", "09:06"]) {
    capturedOnUpdate!(waiting(`2026-09-12T${min}:00.000Z`));
    clock += 10_000;
    timer.advance();
    await flush();
  }
  expect(fired.length).toBe(afterFirst);

  ac.abort();
  expect(await p).toBe(0);
});

// --- single instance ---------------------------------------------------
// Stacking daemons is not a harmless duplicate: each one holds its own
// notified-set, so N daemons mean N notifications, and an old one left behind
// by a failed `kill %1` keeps serving stale behaviour long after a rebuild.

function fakeLock(holder: number | null = null) {
  const state = { holder, released: 0, killed: [] as number[] };
  return {
    state,
    lock: {
      acquire: (_p: string) => {
        if (state.holder !== null) return null;
        state.holder = process.pid;
        return { release: () => { state.released++; state.holder = null; } };
      },
      holder: (_p: string) => state.holder,
      kill: (pid: number) => { state.killed.push(pid); state.holder = null; },
    },
  };
}

test("refuses to start when a live daemon already holds the lock", async () => {
  const { fs: fsDeps } = memFsDeps();
  const lg: string[] = [];
  const f = fakeLock(4242);

  const code = await runNotifyd(
    { hubUrl: "http://127.0.0.1:1", lockPath: "/run/u/agmux/notifyd.lock" },
    baseDeps({ fs: fsDeps, lock: f.lock, log: (s) => lg.push(s),
      makeFeed: () => ({ subscribe: () => () => {} }) }),
  );

  expect(code).toBe(1);
  expect(lg.join(" ")).toContain("4242");
  expect(lg.join(" ")).toContain("--replace");
  expect(f.state.killed).toEqual([]);
});

test("--replace terminates the incumbent and takes over", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();
  const f = fakeLock(4242);

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal, replace: true,
      lockPath: "/run/u/agmux/notifyd.lock" },
    baseDeps({ fs: fsDeps, lock: f.lock, makeFeed: () => ({ subscribe: () => () => {} }) }),
  );
  await flush();

  expect(f.state.killed).toEqual([4242]);
  ac.abort();
  expect(await p).toBe(0);
  expect(f.state.released).toBe(1);   // lock handed back on shutdown
});

test("releases the lock on shutdown so the next start is clean", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();
  const f = fakeLock(null);

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal, lockPath: "/run/u/agmux/notifyd.lock" },
    baseDeps({ fs: fsDeps, lock: f.lock, makeFeed: () => ({ subscribe: () => () => {} }) }),
  );
  await flush();
  ac.abort();
  expect(await p).toBe(0);
  expect(f.state.released).toBe(1);
  expect(f.state.holder).toBeNull();
});

test("without a lockPath the daemon starts unguarded (tests, one-offs)", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();
  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({ fs: fsDeps, makeFeed: () => ({ subscribe: () => () => {} }) }),
  );
  ac.abort();
  expect(await p).toBe(0);
});

test("pane signals: a done session under a focused client is posted as seen to the live hub", async () => {
  const ac = new AbortController();
  let onUpdate: ((rows: SessionRow[]) => void) | undefined;
  const posts: { hub: string; kinds: string[] }[] = [];
  const p = runNotifyd(
    { hubUrl: "http://stale:1", resolveHubUrl: () => "http://live:2", stop: ac.signal },
    baseDeps({
      fs: memFsDeps().fs,
      makeFeed: () => ({ subscribe: (u) => { onUpdate = u; return () => {}; } }),
      paneSignals: {
        capture: async (_c, args) => (args.includes("list-clients") ? "attached,focused\t%7" : ""),
        host: "h", newId: () => "e",
        post: async (hub, events) => { posts.push({ hub, kinds: events.map((e) => e.kind) }); },
      },
    }),
  );
  onUpdate!([{ ...row, status: "done", origin: "wrapper", attention_ts: "a1" }]);
  for (let i = 0; i < 20 && posts.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(posts).toEqual([{ hub: "http://live:2", kinds: ["session.seen"] }]);
  ac.abort();
  expect(await p).toBe(0);
});
