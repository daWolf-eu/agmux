import * as fs from "node:fs";
import * as path from "node:path";
import { AGMUX_VERSION, REPLICATION_VERSION, type ReplicationHeader, type ReplicationRecord } from "@agmux/protocol";
import { EXPORT_MAX_LIMIT, isProcessAlive } from "@agmux/hub";

// `agmux events`: the remote side of replication. Streams this host's exportable
// event log as NDJSON (header, records, keepalives) for the Mac's follower.
export const FOLLOW_POLL_MS = 500;
export const KEEPALIVE_MS = 15_000;
const DEFAULT_LIMIT = 500;
const CONSUMER_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type EventsArgs =
  | { kind: "ok"; follow: boolean; after: number; consumer: string | null; limit: number }
  | { kind: "error"; message: string };

export function parseEventsArgs(argv: string[]): EventsArgs {
  let follow = false;
  let after: number | null = null;
  let consumer: string | null = null;
  let limit = DEFAULT_LIMIT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--follow") { follow = true; continue; }
    if (a !== "--after" && a !== "--consumer" && a !== "--limit") {
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
    else if (n < 1) return { kind: "error", message: "events: --limit must be positive" };
    else if (n > EXPORT_MAX_LIMIT) {
      // The hub clamps page size; a larger limit would make a clamped full page look short.
      return { kind: "error", message: `events: --limit must be at most ${EXPORT_MAX_LIMIT}` };
    } else limit = n;
  }
  if (after === null) return { kind: "error", message: "events: --after <n> is required" };
  return { kind: "ok", follow, after, consumer, limit };
}

export interface EventsOpts {
  hubUrl: string; follow: boolean; after: number; consumer: string | null; limit: number;
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
  pid?: number;
}

// One follower per consumer id: SIGTERM a live previous one, then claim the file.
// A dead pid is just overwritten. Returns a release that only removes our own claim
// (the replaced follower's exit cleanup must not delete a file that is now ours).
function claimConsumer(consumer: string, deps: EventsDeps): () => void {
  const dir = path.join(deps.stateDir, "follow");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${consumer}.pid`);
  const self = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  let prev = NaN;
  try { prev = parseInt(fs.readFileSync(file, "utf8").trim(), 10); } catch { /* no previous follower */ }
  if (Number.isInteger(prev) && prev > 0 && prev !== self && isAlive(prev)) {
    try { kill(prev, "SIGTERM"); } catch { /* already gone */ }
  }
  fs.writeFileSync(file, `${self}\n`);
  return () => {
    try {
      if (parseInt(fs.readFileSync(file, "utf8").trim(), 10) === self) fs.unlinkSync(file);
    } catch { /* already removed */ }
  };
}

export async function eventsCmd(opts: EventsOpts, deps: EventsDeps): Promise<number> {
  const release = opts.consumer ? claimConsumer(opts.consumer, deps) : () => {};
  try {
    return await stream(opts, deps);
  } finally {
    release();
  }
}

async function stream(opts: EventsOpts, deps: EventsDeps): Promise<number> {
  let lastWrite = deps.nowMs();
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
  while (!opts.signal?.aborted) {
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
