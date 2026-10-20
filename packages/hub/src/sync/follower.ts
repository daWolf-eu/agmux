import type { ReplicationHeader, ReplicationRecord } from "@agmux/protocol";
import type { Store } from "@agmux/store";
import type { DiscoveredNode } from "./discovery.ts";
import { checkHeader, ingestReplicated, parseStreamLine, type IngestOutcome } from "./ingest.ts";
import type { Transport } from "./transport.ts";

// One long-lived `agmux events --follow` child per sandbox, run through the
// transport. The child's stdin is a pipe that is never written or closed: with
// `exec --no-tty` that is what ties the remote command's life to the local
// process (spike 2026-10-11, design change #1). A closed stdin orphans it.

export const IDLE_TIMEOUT_MS = 60_000;
export const MAX_BACKOFF_MS = 300_000;
export const KILL_GRACE_MS = 5_000;   // SIGTERM → SIGKILL
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
}

// Splits a UTF-8 byte stream on "\n"; a trailing partial line is yielded at the end.
export async function* splitLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
  }
  buf += dec.decode();
  if (buf) yield buf;
}

export function spawnProcess(argv: string[], spawnImpl: typeof Bun.spawn = Bun.spawn): ProcHandle {
  // stdin stays an open pipe for the child's whole life — never write to or end it.
  const p = spawnImpl(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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

type Failed = { kind: "failed"; error: string; permanent: boolean };
type Outcome =
  | Failed
  | { kind: "reset" }      // sandbox db changed: respawn from cursor 0 right away
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
    failures = 0;
    notify();
    return null;
  }

  function onRecord(rec: ReplicationRecord): void {
    // Sandbox output is untrusted: a record that makes the store throw is just a rejected record.
    let r: IngestOutcome;
    try { r = ingestReplicated(o.store, rec, o.node.host); } catch (e) { r = { ok: false, reason: `append failed: ${errMsg(e)}` }; }
    st.cursor = Math.max(st.cursor, rec.id);
    if (!r.ok) { st.rejected++; st.lastError = `record ${rec.id}: ${r.reason}`; }
    notify();
  }

  function onLine(line: string): Outcome | null {
    const l = parseStreamLine(line);
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
    let abort!: (out: Outcome) => void;
    const aborted = new Promise<{ abort: Outcome }>((r) => { abort = (out) => r({ abort: out }); });
    abortAttempt = abort;
    let lastLineMs = deps.nowMs();
    const endWatchdog = watchdog(() => lastLineMs, abort);
    const it = p.lines[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = it.next();
        next.catch(() => {});   // may settle after an abort, unobserved
        const r = await Promise.race([next, aborted]);
        if ("abort" in r) return r.abort;
        if (r.done) return null;
        lastLineMs = deps.nowMs();
        const out = onLine(r.value);
        if (out) return out;
      }
    } catch (e) {
      return fail(`stream error: ${errMsg(e)}`);
    } finally {
      abortAttempt = null;
      endWatchdog();
    }
  }

  async function attempt(): Promise<Outcome> {
    const cmd = [o.agmuxBin, "events", "--follow", "--after", String(st.cursor), "--consumer", o.consumer];
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
      const tail = p.stderrTail?.().trim() ?? "";
      const what = st.connected ? `stream ended (exit ${code ?? "?"})` : `exited ${code ?? "?"} before replication header`;
      out = fail(tail ? `${what}: ${tail}` : what);
      if (stopping) return { kind: "stopped" };
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
      if (out.kind === "reset") continue;
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
