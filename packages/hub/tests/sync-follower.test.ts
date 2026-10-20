import { describe, expect, spyOn, test } from "bun:test";
import { Store } from "@agmux/store";
import {
  IDLE_TIMEOUT_MS, KILL_GRACE_MS, LINE_TOO_LONG, MAX_BACKOFF_MS, MAX_LINE_BYTES, abortableReader, spawnProcess, splitLines, startFollower,
  type FollowerStatus, type ProcHandle,
} from "../src/sync/follower.ts";
import type { Transport } from "../src/sync/transport.ts";

const HOST = "gw/sbx";
const TS = "2026-06-08T00:00:00.000Z";
const INTERVAL = 1_000;
let n = 0;

const sid = (i: number) => `0190a3e0-0000-7000-8000-${String(i).padStart(12, "0")}`;
function registered(i: number, host = HOST): any {
  return {
    event_id: "e" + ++n, ts: TS, session_id: sid(i), kind: "session.registered", version: 1, host,
    payload: { agent_kind: "claude", tmux_session: "main", tmux_window: "1", tmux_pane: "%3",
      cwd: "/tmp", profile: null, agent_version: null, parent: null, native_session_id: "nat-" + i, pid: 42 },
  };
}
const header = (o: Partial<{ db_id: string; host: string; replication: number }> = {}) =>
  JSON.stringify({ replication: 1, agmux: "0.1.0", db_id: "db-1", host: HOST, ...o });
const record = (id: number, ev: any = registered(id)) => JSON.stringify({ id, ev });
const keepalive = () => JSON.stringify({ keepalive: TS });

// A scripted child: the test pushes lines and ends it; kill() ends it with 143.
// A wedged child ignores every signal: its lines never end and it never exits.
class FakeProc implements ProcHandle {
  killed = 0;
  released = false;   // the follower called return() on the lines iterator
  signals: string[] = [];
  private queue: string[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private resolveExit!: (code: number) => void;
  readonly exited = new Promise<number>((r) => { this.resolveExit = r; });
  constructor(readonly argv: string[], private tail = "", private wedged = false) {}
  push(...lines: string[]) { this.queue.push(...lines); this.wake?.(); }
  end(code = 0) { if (this.done) return; this.done = true; this.resolveExit(code); this.wake?.(); }
  kill(signal = "SIGTERM") { this.killed++; this.signals.push(signal); if (!this.wedged) this.end(143); }
  stderrTail() { return this.tail; }
  get lines(): AsyncIterable<string> {
    const self = this;
    return (async function* () {
      let finished = false;
      try {
        for (;;) {
          while (self.queue.length) yield self.queue.shift()!;
          if (self.done) { finished = true; return; }
          await new Promise<void>((r) => { self.wake = r; });
          self.wake = null;
        }
      } finally {
        if (!finished) self.released = true;
      }
    })();
  }
}

const transport: Transport = {
  spec: (target) => ({ kind: "openshell", gateway: "gw", target, bin: "openshell" }),
  argv: (target, cmd, o) => ["openshell", "exec", "-n", target, o.tty ? "--tty" : "--no-tty", "--", ...cmd],
};

// One event-loop turn; repeated until the follower's async chain settles.
const turn = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, what = "condition") {
  for (let i = 0; i < 200; i++) { if (cond()) return; await turn(); }
  throw new Error(`timed out waiting for ${what}`);
}

function harness(o: {
  cursor?: number; dbId?: string | null; store?: Store; stderr?: string; spawnThrows?: number;
  wedged?: boolean; onChange?: (s: FollowerStatus) => void;
} = {}) {
  let now = 0;
  const sleeps: { at: number; resolve: () => void }[] = [];
  const sleepCalls: number[] = [];
  const procs: FakeProc[] = [];
  const changes: FollowerStatus[] = [];
  const store = o.store ?? Store.openInMemory();
  const f = startFollower({
    store, node: { target: "sbx", host: HOST }, transport, agmuxBin: "/usr/local/bin/agmux", consumer: "mac",
    cursor: o.cursor ?? 0, dbId: o.dbId ?? null, intervalMs: INTERVAL,
    onChange: (s) => { changes.push(s); o.onChange?.(s); },
  }, {
    spawn: (argv) => {
      if (o.spawnThrows && o.spawnThrows-- > 0) throw new Error("ENOENT: openshell");
      const p = new FakeProc(argv, o.stderr, o.wedged); procs.push(p); return p; },
    nowMs: () => now,
    sleep: (ms) => { sleepCalls.push(ms); return new Promise<void>((resolve) => sleeps.push({ at: now + ms, resolve })); },
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const s of sleeps.filter((s) => s.at <= now)) { sleeps.splice(sleeps.indexOf(s), 1); s.resolve(); }
    await turn();
  };
  // Backoff sleeps only: the watchdog's first sleep per connection is IDLE_TIMEOUT_MS,
  // and every exit wait is KILL_GRACE_MS.
  const backoffs = () => sleepCalls.filter((ms) => ms !== IDLE_TIMEOUT_MS && ms !== KILL_GRACE_MS);
  return { f, store, procs, changes, advance, backoffs, sleepCalls, last: () => procs[procs.length - 1]! };
}

const afterArg = (p: FakeProc) => p.argv[p.argv.indexOf("--after") + 1];

describe("startFollower", () => {
  test("streams records and advances the cursor", async () => {
    const h = harness();
    await until(() => h.procs.length === 1, "spawn");
    expect(h.procs[0]!.argv).toEqual([
      "openshell", "exec", "-n", "sbx", "--no-tty", "--",
      "/usr/local/bin/agmux", "events", "--follow", "--after", "0", "--consumer", "mac",
    ]);
    h.last().push(header(), record(3), keepalive(), record(5), record(8, registered(8, "evil")), "not json");
    await until(() => h.f.status().rejected === 2, "records");
    const s = h.f.status();
    expect(s).toMatchObject({ connected: true, cursor: 8, dbId: "db-1", failingSinceMs: null, permanent: false });
    expect(s.header?.db_id).toBe("db-1");
    expect(s.lastError).toContain("not JSON");
    expect(h.store.sessionHost(sid(3))).toBe(HOST);
    expect(h.store.sessionHost(sid(5))).toBe(HOST);
    expect(h.store.sessionHost(sid(8))).toBeNull();
    expect(h.changes[0]).toMatchObject({ connected: true, cursor: 0 });
    expect(h.changes.map((c) => c.cursor)).toContain(5);
    await h.f.stop();
  });

  test("an oversized line is a rejected `invalid line: too long`; the stream continues", async () => {
    const h = harness();
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header(), LINE_TOO_LONG, record(3));
    await until(() => h.f.status().cursor === 3, "records");
    expect(h.f.status()).toMatchObject({ connected: true, rejected: 1, lastError: "invalid line: too long" });
    expect(h.store.sessionHost(sid(3))).toBe(HOST);
    await h.f.stop();
  });

  test("an ingest that throws counts as rejected and the stream continues", async () => {
    const store = Store.openInMemory();
    let calls = 0;
    const orig = store.appendReplicated.bind(store);
    store.appendReplicated = (ev, src) => {
      if (++calls === 1) throw new Error("UNIQUE constraint failed");
      return orig(ev, src);
    };
    const h = harness({ store });
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header(), record(4), record(6));
    await until(() => h.f.status().cursor === 6, "records");
    expect(h.f.status()).toMatchObject({ connected: true, rejected: 1 });
    expect(h.f.status().lastError).toContain("append failed: UNIQUE constraint failed");
    expect(h.store.sessionHost(sid(6))).toBe(HOST);
    expect(h.procs).toHaveLength(1);
    expect(h.last().killed).toBe(0);
    await h.f.stop();
  });

  test("reconnect resumes from the last cursor", async () => {
    const h = harness();
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header(), record(3), record(7));
    await until(() => h.f.status().cursor === 7, "records");
    h.last().end(255);
    await until(() => h.backoffs().length === 1, "backoff");
    expect(h.f.status()).toMatchObject({ connected: false, failingSinceMs: 0 });
    expect(h.f.status().lastError).toContain("255");
    expect(h.backoffs()).toEqual([INTERVAL]);
    await h.advance(INTERVAL);
    await until(() => h.procs.length === 2, "respawn");
    expect(afterArg(h.last())).toBe("7");
    await h.f.stop();
  });

  test("silent stream is restarted by the watchdog", async () => {
    const h = harness();
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header());
    await until(() => h.f.status().connected, "header");
    await h.advance(30_000);
    h.last().push(keepalive());
    await turn();
    await h.advance(IDLE_TIMEOUT_MS - 1);
    expect(h.procs[0]!.killed).toBe(0);
    await h.advance(30_001);
    await until(() => h.sleepCalls.at(-1) === INTERVAL, "backoff");
    expect(h.procs[0]!.killed).toBe(1);
    expect(h.f.status()).toMatchObject({ connected: false, lastError: "stream idle for 60s" });
    await h.advance(INTERVAL);
    await until(() => h.procs.length === 2, "respawn");
    await h.f.stop();
  });

  test("backoff doubles to the cap and resets after a header", async () => {
    const h = harness();
    const fails: number[] = [];
    for (let i = 0; i < 11; i++) {
      await until(() => h.procs.length === i + 1, "spawn " + i);
      h.last().end(1);
      await until(() => h.backoffs().length === i + 1, "backoff " + i);
      const ms = h.backoffs()[i]!;
      fails.push(ms);
      await h.advance(ms);
    }
    expect(fails).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300].map((s) => s * 1000));
    expect(h.f.status().failingSinceMs).toBe(0);
    await until(() => h.procs.length === 12, "spawn 11");
    h.last().push(header());
    await until(() => h.f.status().connected, "header");
    expect(h.f.status()).toMatchObject({ failingSinceMs: null, lastError: null });
    h.last().end(0);
    await until(() => h.backoffs().length === 12, "backoff after header");
    expect(h.backoffs()[11]).toBe(INTERVAL);
    await h.f.stop();
  });

  test("host mismatch fails fast with an actionable error", async () => {
    const h = harness();
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header({ host: "144190573f15" }), record(1, registered(1, "144190573f15")), record(2));
    await until(() => h.backoffs().length === 1, "backoff");
    expect(h.procs[0]!.killed).toBe(1);
    const s = h.f.status();
    expect(s).toMatchObject({ connected: false, permanent: true, cursor: 0 });
    expect(s.lastError).toContain("AGMUX_HOST=gw/sbx");
    expect(h.backoffs()).toEqual([MAX_BACKOFF_MS]);
    expect(h.store.listEvents()).toHaveLength(0);
    await h.f.stop();
  });

  test("first line not a header is an error", async () => {
    const h = harness();
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(record(1));
    await until(() => h.backoffs().length === 1, "backoff");
    expect(h.procs[0]!.killed).toBe(1);
    expect(h.f.status()).toMatchObject({ cursor: 0, lastError: "no replication header" });
    expect(h.procs[0]!.released).toBe(true);
    expect(h.store.listEvents()).toHaveLength(0);
    await h.f.stop();
  });

  test("exit before a header reports the stderr tail", async () => {
    const h = harness({ stderr: "error: sandbox not found\n" });
    await until(() => h.procs.length === 1, "spawn");
    h.last().end(2);
    await until(() => h.backoffs().length === 1, "backoff");
    expect(h.f.status().lastError).toBe("exited 2 before replication header: error: sandbox not found");
    await h.f.stop();
  });

  test("a spawn that throws is a failure and is retried", async () => {
    const h = harness({ spawnThrows: 1 });
    await until(() => h.backoffs().length === 1, "backoff");
    expect(h.f.status().lastError).toBe("spawn failed: ENOENT: openshell");
    await h.advance(INTERVAL);
    await until(() => h.procs.length === 1, "respawn");
    await h.f.stop();
  });

  test("db_id change restarts from cursor 0", async () => {
    const h = harness({ cursor: 5, dbId: "db-old" });
    await until(() => h.procs.length === 1, "spawn");
    expect(afterArg(h.last())).toBe("5");
    h.last().push(header({ db_id: "db-new" }), record(6));
    await until(() => h.procs.length === 2, "respawn");
    expect(h.procs[0]!.killed).toBe(1);
    expect(await h.procs[0]!.exited).toBe(143);
    expect(afterArg(h.last())).toBe("0");
    expect(h.backoffs()).toEqual([]);
    expect(h.f.status()).toMatchObject({ cursor: 0, dbId: "db-new" });
    expect(h.changes.some((c) => c.cursor === 0 && c.dbId === "db-new")).toBe(true);
    expect(h.store.listEvents()).toHaveLength(0);
    h.last().push(header({ db_id: "db-new" }), record(1));
    await until(() => h.f.status().cursor === 1, "record");
    expect(h.procs).toHaveLength(2);
    await h.f.stop();
  });

  test("db_id reset waits for the old child to exit before respawning", async () => {
    const h = harness({ cursor: 5, dbId: "db-old", wedged: true });
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header({ db_id: "db-new" }));
    await until(() => h.procs[0]!.signals.length === 1, "SIGTERM");
    await h.advance(KILL_GRACE_MS - 1);
    expect(h.procs).toHaveLength(1);
    await h.advance(1);
    await until(() => h.procs.length === 2, "respawn");
    expect(h.procs[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(afterArg(h.last())).toBe("0");
    const stopped = h.f.stop();
    await until(() => h.last().signals.length === 1, "SIGTERM 2");
    await h.advance(KILL_GRACE_MS);
    await stopped;
  });

  test("stop() kills the process and resolves", async () => {
    const h = harness();
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header());
    await until(() => h.f.status().connected, "header");
    const seen = h.changes.length;
    await h.f.stop();
    expect(h.procs[0]!.killed).toBe(1);
    await h.advance(MAX_BACKOFF_MS);
    expect(h.procs).toHaveLength(1);
    expect(h.changes).toHaveLength(seen);
  });

  test("a wedged child is abandoned after the watchdog and replaced", async () => {
    const h = harness({ wedged: true });
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header(), record(2));
    await until(() => h.f.status().cursor === 2, "record");
    await h.advance(IDLE_TIMEOUT_MS);
    await until(() => h.procs[0]!.signals.length === 1, "SIGTERM");
    expect(h.f.status()).toMatchObject({ connected: false, lastError: "stream idle for 60s", failingSinceMs: IDLE_TIMEOUT_MS });
    expect(h.changes.at(-1)).toMatchObject({ connected: false, lastError: "stream idle for 60s" });
    await h.advance(KILL_GRACE_MS);
    await until(() => h.backoffs().length === 1, "backoff");
    expect(h.procs[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await h.advance(INTERVAL);
    await until(() => h.procs.length === 2, "respawn");
    expect(afterArg(h.last())).toBe("2");
    const stopped = h.f.stop();
    await until(() => h.last().signals.length === 1, "SIGTERM 2");
    await h.advance(KILL_GRACE_MS);
    await stopped;
  });

  test("stop() on a wedged child resolves after the kill grace with SIGKILL", async () => {
    const h = harness({ wedged: true });
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header());
    await until(() => h.f.status().connected, "header");
    let stopped = false;
    const stopping = h.f.stop().then(() => { stopped = true; });
    await until(() => h.procs[0]!.signals.length === 1, "SIGTERM");
    expect(stopped).toBe(false);
    await h.advance(KILL_GRACE_MS);
    await stopping;
    expect(h.procs[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await h.advance(IDLE_TIMEOUT_MS + MAX_BACKOFF_MS);
    expect(h.procs).toHaveLength(1);
  });

  test("a throwing onChange is logged and the stream keeps working", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness({ onChange: () => { throw new Error("SQLITE_BUSY"); } });
      await until(() => h.procs.length === 1, "spawn");
      h.last().push(header(), record(3), record(4));
      await until(() => h.f.status().cursor === 4, "records");
      expect(h.f.status()).toMatchObject({ connected: true, lastError: null, rejected: 0 });
      expect(h.last().killed).toBe(0);
      h.last().end(1);
      await until(() => h.backoffs().length === 1, "backoff after a throwing failure notify");
      await h.advance(INTERVAL);
      await until(() => h.procs.length === 2, "respawn");
      expect(err).toHaveBeenCalled();
      expect(String(err.mock.calls[0]![0])).toContain("SQLITE_BUSY");
      await h.f.stop();
    } finally {
      err.mockRestore();
    }
  });

  test("the cursor never moves backwards", async () => {
    const h = harness({ cursor: 10, dbId: "db-1" });
    await until(() => h.procs.length === 1, "spawn");
    h.last().push(header(), record(7), record(12));
    await until(() => h.f.status().cursor === 12, "records");
    expect(h.changes.map((c) => c.cursor).every((c) => c >= 10)).toBe(true);
    await h.f.stop();
  });

  test("stop() during a backoff sleep resolves without respawning", async () => {
    const h = harness();
    await until(() => h.procs.length === 1, "spawn");
    h.last().end(1);
    await until(() => h.backoffs().length === 1, "backoff");
    await h.f.stop();
    await h.advance(INTERVAL);
    expect(h.procs).toHaveLength(1);
  });
});

describe("abortableReader", () => {
  async function* count(n: number) { for (let i = 0; i < n; i++) yield i; }

  test("holds at most one waiter over a long stream", async () => {
    const r = abortableReader(count(10_000));
    let seen = 0;
    let max = 0;
    for (;;) {
      const p = r.next();
      max = Math.max(max, r.waiting());
      const s = await p;
      if (s.kind !== "value") break;
      seen++;
    }
    expect(seen).toBe(10_000);
    expect(max).toBe(1);
    expect(r.waiting()).toBe(0);
  });

  test("abort settles the read in flight and every later read; release returns the iterator", async () => {
    let returned = false;
    const it: AsyncIterator<number> = {
      next: () => new Promise(() => {}),   // a wedged pipe
      return: async () => { returned = true; return { done: true, value: undefined }; },
    };
    const r = abortableReader(it);
    const p = r.next();
    r.abort();
    expect(await p).toEqual({ kind: "aborted" });
    expect(await r.next()).toEqual({ kind: "aborted" });
    expect(r.waiting()).toBe(0);
    r.release();
    await turn();
    expect(returned).toBe(true);
  });
});

describe("spawnProcess", () => {
  test("spawns with a stdin pipe", () => {
    let opts: any;
    const fake: any = (_argv: string[], o: any) => {
      opts = o;
      return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0), kill() {} };
    };
    spawnProcess(["x"], fake);
    expect(opts).toEqual({ stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  });

  test("stdin is never closed", async () => {
    const p = spawnProcess([process.execPath, "-e",
      "process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('EOF'));console.log('ready')"]);
    const lines: string[] = [];
    const reading = (async () => { for await (const l of p.lines) lines.push(l); })();
    await Bun.sleep(300);
    p.kill();
    await reading;
    expect(await p.exited).not.toBe(0);
    expect(lines).toEqual(["ready"]);
  });
});

describe("splitLines", () => {
  test("splits on newlines across chunks and decodes split UTF-8", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode("a\nüb");
    const chunks = [bytes.slice(0, 3), bytes.slice(3), enc.encode("\n\npartial")];
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
    const out: string[] = [];
    for await (const l of splitLines(stream)) out.push(l);
    expect(out).toEqual(["a", "üb", "", "partial"]);
  });

  const streamOf = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
  const collect = async (st: ReadableStream<Uint8Array>) => { const out: string[] = []; for await (const l of splitLines(st)) out.push(l); return out; };

  test("a 3 MB line becomes one LINE_TOO_LONG; the lines around it survive", async () => {
    const enc = new TextEncoder();
    const big = new Uint8Array(3 * 1024 * 1024).fill(0x61);
    const out = await collect(streamOf([enc.encode("before\nxx"), big.subarray(0, 1_000_000), big.subarray(1_000_000), enc.encode("yy\nafter\ntail")]));
    expect(out).toEqual(["before", LINE_TOO_LONG, "after", "tail"]);
  });

  test("a line of exactly MAX_LINE_BYTES is kept", async () => {
    const line = new Uint8Array(MAX_LINE_BYTES).fill(0x62);
    const out = await collect(streamOf([line, new TextEncoder().encode("\n")]));
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(MAX_LINE_BYTES);
  });

  test("many small chunks without a newline stay linear (8 MB in 4 KB chunks < 1 s)", async () => {
    const chunk = new Uint8Array(4096).fill(0x63);
    const chunks = Array.from({ length: 2048 }, () => chunk);
    const t0 = performance.now();
    const out = await collect(streamOf([...chunks, new TextEncoder().encode("\nok\n")]));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out).toEqual([LINE_TOO_LONG, "ok"]);
  });

  test("1 MB under the cap in 4 KB chunks is not quadratic either", async () => {
    const chunk = new Uint8Array(4096).fill(0x64);
    const t0 = performance.now();
    const out = await collect(streamOf([...Array.from({ length: 255 }, () => chunk), new TextEncoder().encode("\n")]));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out[0]!.length).toBe(255 * 4096);
  });
});
