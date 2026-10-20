import { EXIT_ROTATE, type ReplicationHeader, type ReplicationRecord } from "@agmux/protocol";
import type { Store } from "@agmux/store";
import type { DiscoveredNode } from "./discovery.ts";
import { checkHeader, ingestReplicated, parseStreamLine, type IngestOutcome } from "./ingest.ts";
import type { Transport } from "./transport.ts";

// One long-lived `agmux events --follow` child per sandbox, run through the
// transport. The child's stdin is closed: openshell 0.0.116 `exec --no-tty`
// starts the remote command only once the local stdin reaches EOF. Closed stdin
// orphans the remote side when the local process dies, so the remote stream is
// bounded: `--max-duration` ends it (EXIT_ROTATE) and the follower reconnects at once;
// a reconnect's `--consumer` lock SIGTERMs any leftover one.

export const IDLE_TIMEOUT_MS = 60_000;
export const MAX_BACKOFF_MS = 300_000;
export const KILL_GRACE_MS = 5_000;   // SIGTERM → SIGKILL
export const FOLLOW_MAX_DURATION_S = 3600;   // remote `--max-duration`: planned rotation, hourly
const STDERR_TAIL_CHARS = 2048;

export interface FollowerStatus {
  connected: boolean; cursor: number; dbId: string | null; header: ReplicationHeader | null;
  rejected: number; lastError: string | null; failingSinceMs: number | null; permanent: boolean;
}
export interface Follower { status(): FollowerStatus; stop(): Promise<void> }
// kill() defaults to SIGTERM. stderrTail: the last ~2 KB the child wrote to stderr, for error messages.
export interface ProcHandle {
  lines: AsyncIterable<string>; kill(signal?: "SIGTERM" | "SIGKILL"): void; exited: Promise<number>; stderrTail?(): string;
}
export interface FollowerDeps {
  spawn(argv: string[]): ProcHandle;
  nowMs(): number;
  // The follower resolves its own waits early on stop; `signal` lets a real timer be cleared too.
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface FollowerOptions {
  store: Store; node: DiscoveredNode; transport: Transport; agmuxBin: string; consumer: string;
  cursor: number; dbId: string | null; intervalMs: number;
  onChange(s: FollowerStatus): void;
  // Asked once per accepted header, after onChange: false fails the attempt (with
  // backoff) before any record is ingested. The sync loop answers "host.synced
  // was written", so remote rows never exist without their hosts row.
  ready?(): boolean;
}

// A sandbox controls this stream: one line may hold at most MAX_LINE_BYTES. A
// longer one is dropped up to its "\n" and yielded as LINE_TOO_LONG instead
// (onLine counts it as an invalid line; the stream continues).
export const MAX_LINE_BYTES = 1 << 20;
export const LINE_TOO_LONG = "\u0000line too long";

// Splits a UTF-8 byte stream on "\n"; a trailing partial line is yielded at the end.
// Each byte is scanned once ("\n" never occurs inside a UTF-8 sequence, so a line
// can be decoded on its own) and a partial line is kept as chunks until its end.
export async function* splitLines(stream: ReadableStream<Uint8Array>, max = MAX_LINE_BYTES): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let parts: Uint8Array[] = [];
  let size = 0;
  let skipping = false;
  const take = (): string => {
    const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
    parts = [];
    size = 0;
    return dec.decode(line);
  };
  for await (const chunk of stream) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      const end = nl < 0 ? chunk.length : nl;
      if (!skipping && end > start) {
        if (size + end - start > max) {
          skipping = true;
          parts = [];
          size = 0;
          yield LINE_TOO_LONG;
        } else {
          parts.push(chunk.slice(start, end));
          size += end - start;
        }
      }
      if (nl < 0) break;
      if (skipping) skipping = false;
      else yield take();
      start = nl + 1;
    }
  }
  if (!skipping && size > 0) yield take();
}

export function spawnProcess(argv: string[], spawnImpl: typeof Bun.spawn = Bun.spawn): ProcHandle {
  // stdin closed: an open stdin keeps `openshell exec --no-tty` from starting the command.
  const p = spawnImpl(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let tail = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of p.stderr) tail = (tail + dec.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
  })().catch(() => {});
  return { lines: splitLines(p.stdout), kill: (signal = "SIGTERM") => p.kill(signal), exited: p.exited, stderrTail: () => tail };
}

const defaultDeps: FollowerDeps = {
  spawn: (argv) => spawnProcess(argv),
  nowMs: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  }),
};

export type ReadStep<T> = { kind: "value"; value: T } | { kind: "done" } | { kind: "aborted" };

// One read at a time from an async iterator; abort() settles the read in flight.
// Each next() registers one waiter that is dropped when it settles, so nothing
// accumulates per item over a long-lived stream (unlike racing every read
// against one shared abort promise). `waiting()` exposes the count for tests.
export function abortableReader<T>(it: AsyncIterator<T>) {
  const waiters = new Set<(s: ReadStep<T>) => void>();
  let aborted = false;
  return {
    next(): Promise<ReadStep<T>> {
      return new Promise<ReadStep<T>>((resolve, reject) => {
        if (aborted) return resolve({ kind: "aborted" });
        const settle = (s: ReadStep<T>) => { waiters.delete(settle); resolve(s); };
        waiters.add(settle);
        it.next().then(
          (r) => settle(r.done ? { kind: "done" } : { kind: "value", value: r.value }),
          (e) => { waiters.delete(settle); reject(e); },
        );
      });
    },
    abort(): void {
      aborted = true;
      for (const w of [...waiters]) w({ kind: "aborted" });
    },
    // Releases the iterator (generator / stream reader) after an early end; fire and forget.
    release(): void {
      try { void Promise.resolve(it.return?.()).catch(() => {}); } catch { /* already finished */ }
    },
    waiting: () => waiters.size,
  };
}

type Failed = { kind: "failed"; error: string; permanent: boolean };
type Outcome =
  | Failed
  | { kind: "reset" }      // sandbox db changed: respawn from cursor 0 right away
  | { kind: "rotate" }     // EXIT_ROTATE after a header (--max-duration): respawn from the cursor right away
  | { kind: "stopped" };

const fail = (error: string, permanent = false): Failed => ({ kind: "failed", error, permanent });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startFollower(o: FollowerOptions, deps: FollowerDeps = defaultDeps): Follower {
  const st: FollowerStatus = {
    connected: false, cursor: o.cursor, dbId: o.dbId, header: null,
    rejected: 0, lastError: null, failingSinceMs: null, permanent: false,
  };
  let stopping = false;
  let failures = 0;
  let abortAttempt: ((out: Outcome) => void) | null = null;
  const cancels = new Set<() => void>();

  // A throwing listener must neither crash the hub nor read as a stream failure.
  const notify = () => {
    if (stopping) return;
    try { o.onChange({ ...st }); } catch (e) { console.error(`agmux-hub: follower ${o.node.host}: onChange threw: ${errMsg(e)}`); }
  };

  // A sleep that stop() (or the attempt ending, for the watchdog) can cut short.
  function pause(ms: number): { done: Promise<void>; cancel(): void } {
    const ac = new AbortController();
    let cancel!: () => void;
    const done = new Promise<void>((resolve) => {
      cancel = () => { ac.abort(); resolve(); };
      deps.sleep(ms, ac.signal).then(() => resolve(), () => resolve());
    });
    cancels.add(cancel);
    void done.then(() => cancels.delete(cancel));
    return { done, cancel };
  }

  // The exit code, or null if the child hasn't exited within KILL_GRACE_MS (or stop() cut the wait short).
  async function exitWithin(p: ProcHandle): Promise<number | null> {
    const t = pause(KILL_GRACE_MS);
    const code = await Promise.race([p.exited.then((c) => c, () => -1), t.done.then(() => null)]);
    t.cancel();
    return code;
  }

  async function terminate(p: ProcHandle): Promise<void> {
    p.kill("SIGTERM");
    if (await exitWithin(p) === null) p.kill("SIGKILL");
  }

  function recordFailure(out: Failed): void {
    failures++;
    Object.assign(st, { connected: false, lastError: out.error, permanent: out.permanent });
    st.failingSinceMs ??= deps.nowMs();
    notify();
  }

  function onHeader(h: ReplicationHeader): Outcome | null {
    const c = checkHeader(h, o.node.host);
    if (!c.ok) return fail(c.error, true);
    if (st.dbId !== null && h.db_id !== st.dbId && st.cursor > 0) {
      st.cursor = 0;
      st.dbId = h.db_id;
      notify();
      return { kind: "reset" };
    }
    Object.assign(st, { connected: true, header: h, dbId: h.db_id, lastError: null, permanent: false, failingSinceMs: null });
    notify();
    if (o.ready && !o.ready()) return fail("host ledger write failed");
    failures = 0;
    return null;
  }

  function onRecord(rec: ReplicationRecord): void {
    // Sandbox output is untrusted: a record that makes the store throw is just a rejected record.
    // Records only arrive once connected, i.e. after the header set dbId.
    let r: IngestOutcome;
    try { r = ingestReplicated(o.store, rec, o.node.host, st.dbId!); } catch (e) { r = { ok: false, reason: `append failed: ${errMsg(e)}` }; }
    st.cursor = Math.max(st.cursor, rec.id);
    if (!r.ok) { st.rejected++; st.lastError = `record ${rec.id}: ${r.reason}`; }
    notify();
  }

  function onLine(line: string): Outcome | null {
    const l = line === LINE_TOO_LONG ? { type: "invalid" as const, reason: "too long" } : parseStreamLine(line);
    if (!st.connected) return l.type === "header" ? onHeader(l.header) : fail("no replication header");
    if (l.type === "record") onRecord(l.record);
    else if (l.type !== "keepalive") {
      st.rejected++;
      st.lastError = `invalid line: ${l.type === "invalid" ? l.reason : "unexpected header"}`;
      notify();
    }
    return null;
  }

  // Aborts the attempt once IDLE_TIMEOUT_MS pass without a line (keepalives count).
  function watchdog(lastLineMs: () => number, abort: (out: Outcome) => void) {
    let ended = false;
    let cancel: (() => void) | null = null;
    void (async () => {
      while (!ended && !stopping) {
        const left = IDLE_TIMEOUT_MS - (deps.nowMs() - lastLineMs());
        if (left <= 0) { abort(fail(`stream idle for ${IDLE_TIMEOUT_MS / 1000}s`)); return; }
        const s = pause(left);
        cancel = s.cancel;
        await s.done;
      }
    })();
    return () => { ended = true; cancel?.(); };
  }

  // Reads lines until the stream ends, a line ends the attempt, or the attempt is
  // aborted (watchdog, stop). An abort never waits for stdout EOF: a wedged child
  // or a grandchild holding the pipe must not block the next attempt.
  async function read(p: ProcHandle): Promise<Outcome | null> {
    const reader = abortableReader(p.lines[Symbol.asyncIterator]());
    let abortOut: Outcome | null = null;
    const abort = (out: Outcome) => { abortOut ??= out; reader.abort(); };
    abortAttempt = abort;
    let lastLineMs = deps.nowMs();
    const endWatchdog = watchdog(() => lastLineMs, abort);
    let eof = false;
    try {
      for (;;) {
        const r = await reader.next();
        if (r.kind === "aborted") return abortOut;
        if (r.kind === "done") { eof = true; return null; }
        lastLineMs = deps.nowMs();
        const out = onLine(r.value);
        if (out) return out;
      }
    } catch (e) {
      return fail(`stream error: ${errMsg(e)}`);
    } finally {
      abortAttempt = null;
      endWatchdog();
      if (!eof) reader.release();
    }
  }

  async function attempt(): Promise<Outcome> {
    const cmd = [
      o.agmuxBin, "events", "--follow", "--after", String(st.cursor), "--consumer", o.consumer,
      "--max-duration", String(FOLLOW_MAX_DURATION_S),
    ];
    st.connected = false;
    let p: ProcHandle;
    try { p = deps.spawn(o.transport.argv(o.node.target, cmd, { tty: false })); } catch (e) {
      const out = fail(`spawn failed: ${errMsg(e)}`);
      recordFailure(out);
      return out;
    }
    let out = await read(p);
    if (out === null) {
      // stdout ended on its own; the child should be exiting.
      const code = await exitWithin(p);
      if (code === null) p.kill("SIGKILL");
      if (stopping) return { kind: "stopped" };
      // Not a failure: lastError, failingSinceMs and the backoff count stay as they are.
      // Exit 0 (SIGTERM, e.g. a consumer-lock replacement) is not a rotation: two
      // followers sharing a consumer id must back off, not replace each other in a loop.
      if (code === EXIT_ROTATE && st.connected) return { kind: "rotate" };
      const tail = p.stderrTail?.().trim() ?? "";
      const what = st.connected ? `stream ended (exit ${code ?? "?"})` : `exited ${code ?? "?"} before replication header`;
      out = fail(tail ? `${what}: ${tail}` : what);
      recordFailure(out);
      return out;
    }
    if (stopping) out = { kind: "stopped" };
    if (out.kind === "failed") recordFailure(out);   // before the kill grace: status turns failing at once
    await terminate(p);
    return out;
  }

  async function run(): Promise<void> {
    while (!stopping) {
      const out = await attempt();
      if (stopping || out.kind === "stopped") return;
      if (out.kind === "reset" || out.kind === "rotate") continue;
      await pause(out.permanent ? MAX_BACKOFF_MS : Math.min(o.intervalMs * 2 ** (failures - 1), MAX_BACKOFF_MS)).done;
    }
  }

  const loop = run().catch((e) => { console.error(`agmux-hub: follower ${o.node.host} crashed: ${errMsg(e)}`); });
  return {
    status: () => ({ ...st }),
    stop: async () => {
      stopping = true;
      for (const c of [...cancels]) c();
      abortAttempt?.({ kind: "stopped" });
      await loop;
    },
  };
}
