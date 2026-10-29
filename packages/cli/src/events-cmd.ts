import * as fs from "node:fs";
import * as path from "node:path";
import { AGMUX_VERSION, EXIT_ROTATE, REPLICATION_VERSION, type ReplicationHeader, type ReplicationRecord } from "@agmux/protocol";
import { EXPORT_MAX_LIMIT, isProcessAlive } from "@agmux/hub";

// `agmux events`: the remote side of replication. Streams this host's exportable
// event log as NDJSON (header, records, keepalives) for the Mac's follower.
export const FOLLOW_POLL_MS = 500;
export const KEEPALIVE_MS = 15_000;
const DEFAULT_LIMIT = 500;
const CONSUMER_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type EventsArgs =
  | { kind: "ok"; follow: boolean; after: number; consumer: string | null; limit: number; maxDurationS: number | null }
  | { kind: "drain"; timeoutS: number }
  | { kind: "error"; message: string };

export const DRAIN_DEFAULT_TIMEOUT_S = 60;
export const DRAIN_POLL_MS = 500;
// A consumer whose pid is gone still counts while its `.after` is this fresh
// (its follower was just replaced or just dropped: the Mac may reconnect any moment).
export const DRAIN_RECENT_MS = 300_000;
export const EXIT_DRAIN_NO_CONSUMER = 3;

export function parseEventsArgs(argv: string[]): EventsArgs {
  let follow = false;
  let after: number | null = null;
  let consumer: string | null = null;
  let limit = DEFAULT_LIMIT;
  let maxDurationS: number | null = null;
  let drain = false;
  let timeoutS: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--follow") { follow = true; continue; }
    if (a === "--drain") { drain = true; continue; }
    if (a !== "--after" && a !== "--consumer" && a !== "--limit" && a !== "--max-duration" && a !== "--timeout") {
      return { kind: "error", message: `events: unknown argument ${a}` };
    }
    const v = argv[++i];
    if (v === undefined) return { kind: "error", message: `events: ${a} needs a value` };
    if (a === "--consumer") {
      if (!CONSUMER_RE.test(v)) return { kind: "error", message: "events: --consumer must match [A-Za-z0-9._-]{1,64}" };
      consumer = v;
      continue;
    }
    if (!/^\d+$/.test(v)) return { kind: "error", message: `events: ${a} must be an integer` };
    const n = Number(v);
    if (a === "--after") after = n;
    else if (n < 1) return { kind: "error", message: `events: ${a} must be positive` };
    else if (a === "--max-duration") maxDurationS = n;
    else if (a === "--timeout") timeoutS = n;
    else if (n > EXPORT_MAX_LIMIT) {
      // The hub clamps page size; a larger limit would make a clamped full page look short.
      return { kind: "error", message: `events: --limit must be at most ${EXPORT_MAX_LIMIT}` };
    } else limit = n;
  }
  if (drain) {
    if (follow || after !== null) return { kind: "error", message: "events: --drain excludes --follow and --after" };
    if (consumer !== null || maxDurationS !== null || limit !== DEFAULT_LIMIT) {
      return { kind: "error", message: "events: --drain takes only --timeout" };
    }
    return { kind: "drain", timeoutS: timeoutS ?? DRAIN_DEFAULT_TIMEOUT_S };
  }
  if (timeoutS !== null) return { kind: "error", message: "events: --timeout needs --drain" };
  if (after === null) return { kind: "error", message: "events: --after <n> is required" };
  if (maxDurationS !== null && !follow) return { kind: "error", message: "events: --max-duration needs --follow" };
  return { kind: "ok", follow, after, consumer, limit, maxDurationS };
}

export interface EventsOpts {
  hubUrl: string; follow: boolean; after: number; consumer: string | null; limit: number;
  // Follow only: exit EXIT_ROTATE at the first loop boundary after this many seconds
  // (the Mac's follower then reconnects), so an orphaned remote stream ends on its own.
  maxDurationS?: number | null;
  // Aborted on SIGTERM/SIGINT: stop streaming, clean up, exit 0.
  signal?: AbortSignal;
}

export interface EventsDeps {
  fetchImpl: typeof fetch;
  // Synchronous line write; false or a throw (EPIPE) means the reader is gone.
  write(line: string): boolean;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
  host: string;
  stateDir: string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  // Is this pid an `agmux events` process? Default: isEventsProcess.
  isFollower?: (pid: number) => boolean;
  pid?: number;
}

export interface ProcProbe {
  platform: NodeJS.Platform;
  readFile?: (file: string) => string;
  ps?: (pid: number) => string;
}

const defaultProbe: ProcProbe = {
  platform: process.platform,
  readFile: (f) => fs.readFileSync(f, "utf8"),
  ps: (pid) => {
    const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) throw new Error(`ps exited ${r.exitCode}`);
    return r.stdout.toString();
  },
};

// A recorded pid may have been reused by an unrelated process after a crash:
// only an argv with an `events` argument counts. Linux reads /proc/<pid>/cmdline
// (NUL-separated); elsewhere `ps`. Unreadable = not ours (the file is stale).
export function isEventsProcess(pid: number, probe: ProcProbe = defaultProbe): boolean {
  try {
    const argv = probe.platform === "linux"
      ? probe.readFile!(`/proc/${pid}/cmdline`).split("\0")
      : probe.ps!(pid).trim().split(/\s+/);
    return argv.includes("events");
  } catch {
    return false;
  }
}

// One follower per consumer id: SIGTERM a live previous one, then claim the file.
// A dead pid, or a live one that is not an `agmux events` process, is just overwritten. Returns a release that only removes our own claim
// (the replaced follower's exit cleanup must not delete a file that is now ours).
function claimConsumer(consumer: string, after: number, deps: EventsDeps): () => void {
  const dir = path.join(deps.stateDir, "follow");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${consumer}.pid`);
  const self = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const isFollower = deps.isFollower ?? ((pid) => isEventsProcess(pid));
  let prev = NaN;
  try { prev = parseInt(fs.readFileSync(file, "utf8").trim(), 10); } catch { /* no previous follower */ }
  if (Number.isInteger(prev) && prev > 0 && prev !== self && isAlive(prev) && isFollower(prev)) {
    try { kill(prev, "SIGTERM"); } catch { /* already gone */ }
  }
  fs.writeFileSync(file, `${self}\n`);
  // What the Mac has committed, for `--drain`: atomic so a reader never sees a torn number.
  const afterFile = path.join(dir, `${consumer}.after`);
  fs.writeFileSync(`${afterFile}.tmp`, `${after}\n`);
  fs.renameSync(`${afterFile}.tmp`, afterFile);
  return () => {
    try {
      if (parseInt(fs.readFileSync(file, "utf8").trim(), 10) === self) fs.unlinkSync(file);
    } catch { /* already removed */ }
  };
}

export async function eventsCmd(opts: EventsOpts, deps: EventsDeps): Promise<number> {
  const release = opts.consumer ? claimConsumer(opts.consumer, opts.after, deps) : () => {};
  try {
    return await stream(opts, deps);
  } finally {
    release();
  }
}

async function stream(opts: EventsOpts, deps: EventsDeps): Promise<number> {
  const startMs = deps.nowMs();
  let lastWrite = startMs;
  // False once the reader is gone.
  const emit = (obj: object): boolean => {
    try {
      if (!deps.write(JSON.stringify(obj))) return false;
    } catch { return false; }
    lastWrite = deps.nowMs();
    return true;
  };

  let dbId: string;
  try {
    const r = await deps.fetchImpl(`${opts.hubUrl}/health`);
    if (!r.ok) return 1;
    dbId = ((await r.json()) as { db_id: string }).db_id;
  } catch { return 1; }
  const header: ReplicationHeader = { replication: REPLICATION_VERSION, agmux: AGMUX_VERSION, db_id: dbId, host: deps.host };
  if (!emit(header)) return 0;

  let cursor = opts.after;
  const deadlineMs = opts.maxDurationS ? startMs + opts.maxDurationS * 1000 : Infinity;
  while (!opts.signal?.aborted) {
    if (deps.nowMs() >= deadlineMs) return EXIT_ROTATE;
    let records: ReplicationRecord[];
    try {
      const r = await deps.fetchImpl(`${opts.hubUrl}/events?after_id=${cursor}&limit=${opts.limit}`);
      if (!r.ok) return 1;
      records = ((await r.json()) as { records: ReplicationRecord[] }).records;
    } catch { return 1; }
    for (const rec of records) {
      if (!emit(rec)) return 0;
      cursor = rec.id;
    }
    if (records.length >= opts.limit) continue; // more may be waiting
    if (!opts.follow) return 0;
    if (records.length === 0) {
      if (deps.nowMs() - lastWrite >= KEEPALIVE_MS && !emit({ keepalive: new Date(deps.nowMs()).toISOString() })) return 0;
      await deps.sleep(FOLLOW_POLL_MS);
    }
  }
  return 0;
}

export interface DrainDeps {
  fetchImpl: typeof fetch;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
  stateDir: string;
  err(line: string): void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  isFollower?: (pid: number) => boolean;
}

interface DrainConsumer { name: string; pid: number | null; livePid: boolean; after: number; recent: boolean }

function readInt(file: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

// Every consumer known in <state>/follow with its live/recent status. Missing `.after` = -1 (lagging).
function scanConsumers(deps: DrainDeps): DrainConsumer[] {
  const dir = path.join(deps.stateDir, "follow");
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const isAlive = deps.isAlive ?? isProcessAlive;
  const isFollower = deps.isFollower ?? ((pid) => isEventsProcess(pid));
  const names = new Set<string>();
  for (const f of files) {
    const m = f.match(/^(.+)\.(pid|after)$/);
    if (m && CONSUMER_RE.test(m[1]!)) names.add(m[1]!);
  }
  return [...names].sort().map((name) => {
    const pid = readInt(path.join(dir, `${name}.pid`));
    const livePid = pid !== null && pid > 0 && isAlive(pid) && isFollower(pid);
    const afterFile = path.join(dir, `${name}.after`);
    let recent = false;
    try { recent = deps.nowMs() - fs.statSync(afterFile).mtimeMs <= DRAIN_RECENT_MS; } catch { /* no .after */ }
    return { name, pid: livePid ? pid : null, livePid, after: readInt(afterFile) ?? -1, recent };
  }).filter((c) => c.livePid || c.recent);
}

// `agmux events --drain`: run in the sandbox before it is deleted. Nudges each live
// follower to reconnect (the Mac then re-announces its committed cursor in `.after`)
// and waits until every counted consumer's cursor has reached this hub's head.
export async function drainCmd(opts: { hubUrl: string; timeoutS: number }, deps: DrainDeps): Promise<number> {
  const startMs = deps.nowMs();
  let head: number;
  try {
    const r = await deps.fetchImpl(`${opts.hubUrl}/events/head`);
    if (!r.ok) throw new Error(`hub answered ${r.status}`);
    head = ((await r.json()) as { id: number }).id;
  } catch (e) {
    deps.err(`agmux events --drain: cannot read the event head: ${(e as Error).message}`);
    return 1;
  }
  const initial = scanConsumers(deps);
  if (initial.length === 0) {
    deps.err("agmux events --drain: no replication consumer");
    return EXIT_DRAIN_NO_CONSUMER;
  }
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  for (const c of initial) {
    if (c.pid === null) continue;
    try { kill(c.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  const names = initial.map((c) => c.name);
  const deadlineMs = startMs + opts.timeoutS * 1000;
  for (;;) {
    const dir = path.join(deps.stateDir, "follow");
    const lagging = names
      .map((name) => ({ name, after: readInt(path.join(dir, `${name}.after`)) ?? -1 }))
      .filter((c) => c.after < head);
    if (lagging.length === 0) return 0;
    if (deps.nowMs() >= deadlineMs) {
      deps.err(`agmux events --drain: timed out after ${opts.timeoutS}s; head ${head}; lagging: ` +
        lagging.map((c) => `${c.name} (after ${c.after})`).join(", "));
      return 1;
    }
    await deps.sleep(DRAIN_POLL_MS);
  }
}
