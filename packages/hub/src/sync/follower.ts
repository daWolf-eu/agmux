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
const STDERR_TAIL_CHARS = 2048;

export interface FollowerStatus {
  connected: boolean; cursor: number; dbId: string | null; header: ReplicationHeader | null;
  rejected: number; lastError: string | null; failingSinceMs: number | null; permanent: boolean;
}
export interface Follower { status(): FollowerStatus; stop(): Promise<void> }
// stderrTail: the last ~2 KB the child wrote to stderr, for error messages.
export interface ProcHandle { lines: AsyncIterable<string>; kill(): void; exited: Promise<number>; stderrTail?(): string }
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
  return { lines: splitLines(p.stdout), kill: () => p.kill("SIGTERM"), exited: p.exited, stderrTail: () => tail };
}

const defaultDeps: FollowerDeps = {
  spawn: (argv) => spawnProcess(argv),
  nowMs: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  }),
};

type Outcome =
  | { kind: "failed"; error: string; permanent: boolean }
  | { kind: "reset" }      // sandbox db changed: respawn from cursor 0 right away
  | { kind: "stopped" };

const fail = (error: string, permanent = false): Outcome => ({ kind: "failed", error, permanent });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startFollower(o: FollowerOptions, deps: FollowerDeps = defaultDeps): Follower {
  const st: FollowerStatus = {
    connected: false, cursor: o.cursor, dbId: o.dbId, header: null,
    rejected: 0, lastError: null, failingSinceMs: null, permanent: false,
  };
  let stopping = false;
  let proc: ProcHandle | null = null;
  let failures = 0;
  const cancels = new Set<() => void>();

  const notify = () => { if (!stopping) o.onChange({ ...st }); };

  // A sleep that stop() (or the connection ending, for the watchdog) can cut short.
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
    st.cursor = rec.id;
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

  // Kills the child once IDLE_TIMEOUT_MS pass without a line (keepalives count).
  function watchdog(p: ProcHandle, lastLineMs: () => number) {
    let ended = false;
    let fired = false;
    let cancel: (() => void) | null = null;
    void (async () => {
      while (!ended) {
        const left = IDLE_TIMEOUT_MS - (deps.nowMs() - lastLineMs());
        if (left <= 0) { fired = true; p.kill(); return; }
        const s = pause(left);
        cancel = s.cancel;
        await s.done;
      }
    })();
    return { fired: () => fired, end: () => { ended = true; cancel?.(); } };
  }

  async function connectOnce(): Promise<Outcome> {
    const cmd = [o.agmuxBin, "events", "--follow", "--after", String(st.cursor), "--consumer", o.consumer];
    let p: ProcHandle;
    try { p = deps.spawn(o.transport.argv(o.node.target, cmd, { tty: false })); } catch (e) { return fail(`spawn failed: ${errMsg(e)}`); }
    proc = p;
    st.connected = false;
    let lastLineMs = deps.nowMs();
    const wd = watchdog(p, () => lastLineMs);

    let out: Outcome | null = null;
    try {
      for await (const line of p.lines) {
        lastLineMs = deps.nowMs();
        if (stopping || wd.fired()) break;
        if ((out = onLine(line)) !== null) break;
      }
    } catch (e) {
      out = fail(`stream error: ${errMsg(e)}`);
    } finally {
      wd.end();
    }
    if (stopping) return { kind: "stopped" };
    if (out) { p.kill(); return out; }
    if (wd.fired()) return fail(`stream idle for ${IDLE_TIMEOUT_MS / 1000}s`);
    const code = await p.exited;
    const tail = p.stderrTail?.().trim() ?? "";
    const what = st.connected ? `stream ended (exit ${code})` : `exited ${code} before replication header`;
    return fail(tail ? `${what}: ${tail}` : what);
  }

  async function run(): Promise<void> {
    while (!stopping) {
      const out = await connectOnce();
      proc = null;
      if (out.kind === "stopped" || stopping) return;
      if (out.kind === "reset") continue;
      failures++;
      st.connected = false;
      st.lastError = out.error;
      st.permanent = out.permanent;
      st.failingSinceMs ??= deps.nowMs();
      notify();
      await pause(out.permanent ? MAX_BACKOFF_MS : Math.min(o.intervalMs * 2 ** (failures - 1), MAX_BACKOFF_MS)).done;
    }
  }

  const loop = run();
  return {
    status: () => ({ ...st }),
    stop: async () => {
      stopping = true;
      proc?.kill();
      for (const c of [...cancels]) c();
      await loop;
    },
  };
}
