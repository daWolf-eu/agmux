import { describe, expect, test } from "bun:test";
import { NO_SESSION_ID, type EventEnvelope, type ReplicationHeader } from "@agmux/protocol";
import { Store } from "@agmux/store";
import type { RemoteConfig } from "../src/sync/config.ts";
import type { DiscoveredNode, Discovery } from "../src/sync/discovery.ts";
import type { FollowerOptions, FollowerStatus } from "../src/sync/follower.ts";
import { CURSOR_FLUSH_MS, startSync } from "../src/sync/sync-loop.ts";
import type { Transport } from "../src/sync/transport.ts";

// 10 ms real discovery ticks keep the tests fast; the ledger reads the fake clock.
const remote: RemoteConfig = {
  name: "lab", transport: "openshell", gateway: "gw", selector: "agmux=1",
  interval: 0.01, openshell_bin: "openshell", agmux_bin: "agmux",
};
const STALE_MS = 3 * remote.interval * 1000;
const node = (name: string): DiscoveredNode => ({ target: name, host: `gw/${name}` });
const hdr: ReplicationHeader = { replication: 1, agmux: "0.1.0", db_id: "db-1", host: "gw/a" };
const TS = "2026-06-08T00:00:00.000Z";

const transport: Transport = {
  spec: (target) => ({ kind: "openshell", gateway: "gw", target, bin: "openshell" }),
  argv: (target, cmd) => ["openshell", target, ...cmd],
};

class FakeFollower {
  stopped = 0;
  private st: FollowerStatus;
  constructor(readonly o: FollowerOptions) {
    this.st = {
      connected: false, cursor: o.cursor, dbId: o.dbId, header: null,
      rejected: 0, lastError: null, failingSinceMs: null, permanent: false,
    };
  }
  emit(p: Partial<FollowerStatus>) { this.st = { ...this.st, ...p }; this.o.onChange({ ...this.st }); }
  status() { return { ...this.st }; }
  async stop() { this.stopped++; }
}

const turn = () => new Promise<void>((r) => setTimeout(r, 1));
async function until(cond: () => boolean, what = "condition") {
  for (let i = 0; i < 500; i++) { if (cond()) return; await turn(); }
  throw new Error(`timed out waiting for ${what}`);
}
// Long enough for several discovery ticks to run.
const ticks = () => new Promise<void>((r) => setTimeout(r, 50));

function harness(o: { remotes?: RemoteConfig[]; store?: Store } = {}) {
  let now = 1_000_000;
  // "hang": a `sandbox list` that never returns. `once` entries are served before `listing`.
  type Listing = DiscoveredNode[] | Error | "hang";
  let listing: Listing = [];
  const once: Listing[] = [];
  let lists = 0;
  let hangs = 0;
  const store = o.store ?? Store.openInMemory();
  const hostEvents: EventEnvelope[] = [];
  const orig = store.append.bind(store);
  store.append = (ev) => { if (ev.kind.startsWith("host.")) hostEvents.push(ev); return orig(ev); };
  const followers: FakeFollower[] = [];
  const logs: string[] = [];
  const discovery: Discovery = {
    list: async () => {
      lists++;
      const l = once.shift() ?? listing;
      if (l === "hang") { hangs++; return new Promise<never>(() => {}); }
      if (l instanceof Error) throw l;
      return l;
    },
  };
  let id = 0;
  const stop = startSync({ store, remotes: o.remotes ?? [remote], consumer: "mac", log: (s) => logs.push(s) }, {
    discoveryFor: () => discovery,
    transportFor: () => transport,
    follower: ((fo: FollowerOptions) => { const f = new FakeFollower(fo); followers.push(f); return f; }) as any,
    nowMs: () => now,
    newId: () => `ev-${++id}`,
  });
  return {
    store, followers, logs, stop, hostEvents,
    setListing: (l: Listing) => { listing = l; },
    listOnce: (...l: Listing[]) => { once.push(...l); },
    lists: () => lists,
    hangs: () => hangs,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    kinds: () => hostEvents.map((e) => e.kind),
    of: (host: string) => followers.find((f) => f.o.node.host === host)!,
  };
}

function seedSynced(store: Store, host: string, cursor: number, remoteName = "lab") {
  store.append({
    event_id: `seed-${host}-${cursor}`, ts: TS, session_id: NO_SESSION_ID, kind: "host.synced", version: 1, host,
    payload: {
      remote: remoteName, transport: transport.spec(host.split("/")[1]!), cursor, db_id: "db-0",
      agmux_version: "0.1.0", replication: 1, rejected: 0,
    },
    dedup_key: null,
  });
}

describe("startSync", () => {
  test("starts one follower per discovered node with the stored cursor", async () => {
    const store = Store.openInMemory();
    seedSynced(store, "gw/a", 42);
    const h = harness({ store });
    h.setListing([node("a"), node("b")]);
    await until(() => h.followers.length === 2, "followers");
    await ticks();
    expect(h.followers.length).toBe(2);
    expect(h.of("gw/a").o).toMatchObject({
      cursor: 42, dbId: "db-0", consumer: "mac", agmuxBin: "agmux", intervalMs: 10, node: node("a"),
    });
    expect(h.of("gw/b").o).toMatchObject({ cursor: 0, dbId: null });
    await h.stop();
    expect(h.followers.map((f) => f.stopped)).toEqual([1, 1]);
  });

  test("node disappearing appends host.removed once and stops its follower", async () => {
    const h = harness();
    h.setListing([node("a"), node("b")]);
    await until(() => h.followers.length === 2, "followers");
    h.of("gw/a").emit({ connected: true, header: hdr, dbId: "db-1", cursor: 0 });
    expect(h.kinds()).toEqual(["host.synced"]);
    const before = h.lists();
    h.setListing([node("b")]);
    await until(() => h.kinds().includes("host.removed"), "host.removed");
    expect(h.lists()).toBeGreaterThanOrEqual(before + 2);
    await ticks();
    expect(h.kinds()).toEqual(["host.synced", "host.removed"]);
    const removed = h.hostEvents[1]!;
    expect(removed).toMatchObject({
      session_id: NO_SESSION_ID, host: "gw/a", version: 1, dedup_key: null, payload: { remote: "lab" },
    });
    expect(h.of("gw/a").stopped).toBe(1);
    expect(h.store.getHost("gw/a")?.removed_ts).not.toBeNull();
    expect(h.of("gw/b").stopped).toBe(0);
    await h.stop();
  });

  test("a stored host of this remote that is not listed is removed; another remote's is not", async () => {
    const store = Store.openInMemory();
    seedSynced(store, "gw/old", 7);
    seedSynced(store, "gw/foreign", 7, "other");
    const h = harness({ store });
    h.setListing([]);
    await until(() => h.kinds().includes("host.removed"), "host.removed");
    await ticks();
    expect(h.hostEvents.map((e) => [e.kind, e.host])).toEqual([["host.removed", "gw/old"]]);
    await h.stop();
  });

  test("a single miss does not remove", async () => {
    const h = harness();
    h.setListing([node("a"), node("b")]);
    await until(() => h.followers.length === 2, "followers");
    h.of("gw/a").emit({ connected: true, header: hdr, dbId: "db-1" });
    // Missed, seen, missed: never two consecutive misses.
    h.listOnce([node("b")], [node("a"), node("b")], [node("b")]);
    const before = h.lists();
    await until(() => h.lists() > before + 5, "ticks");
    expect(h.kinds()).toEqual(["host.synced"]);
    expect(h.of("gw/a").stopped).toBe(0);
    expect(h.followers.length).toBe(2);
    await h.stop();
  });

  test("discovery failure removes nothing", async () => {
    const h = harness();
    h.setListing([node("a")]);
    await until(() => h.followers.length === 1, "follower");
    h.of("gw/a").emit({ connected: true, header: hdr, dbId: "db-1" });
    h.setListing(new Error("gateway unreachable"));
    const before = h.lists();
    await until(() => h.lists() > before + 3, "failing ticks");
    expect(h.kinds()).toEqual(["host.synced"]);
    expect(h.of("gw/a").stopped).toBe(0);
    expect(h.logs.filter((l) => l.includes("gateway unreachable")).length).toBe(1);
    await h.stop();
  });

  test("cursor flush is debounced", async () => {
    const h = harness();
    h.setListing([node("a")]);
    await until(() => h.followers.length === 1, "follower");
    const f = h.of("gw/a");
    f.emit({ connected: true, header: hdr, dbId: "db-1", cursor: 0 });
    for (let i = 1; i <= 100; i++) { h.advance(90); f.emit({ cursor: i }); }
    await ticks();
    expect(h.kinds()).toEqual(["host.synced"]);
    h.advance(CURSOR_FLUSH_MS);
    // The pending cursor is flushed by the next discovery tick even without a new change.
    await until(() => h.hostEvents.length === 2, "flush");
    expect(h.hostEvents[1]!.payload).toMatchObject({ cursor: 100 });
    await ticks();
    expect(h.hostEvents.length).toBe(2);
    await h.stop();
  });

  test("host.synced carries the follower's header, cursor and rejected count", async () => {
    const h = harness();
    h.setListing([node("a")]);
    await until(() => h.followers.length === 1, "follower");
    h.of("gw/a").emit({ connected: true, header: hdr, dbId: "db-1", cursor: 5, rejected: 2 });
    expect(h.hostEvents[0]).toMatchObject({
      event_id: "ev-1", ts: new Date(h.now()).toISOString(), session_id: NO_SESSION_ID,
      kind: "host.synced", version: 1, host: "gw/a", dedup_key: null,
      payload: {
        remote: "lab", transport: transport.spec("a"), cursor: 5, db_id: "db-1",
        agmux_version: "0.1.0", replication: 1, rejected: 2,
      },
    });
    await h.stop();
  });

  test("sync_failed only after 3 intervals, then synced on recovery", async () => {
    const h = harness();
    h.setListing([node("a")]);
    await until(() => h.followers.length === 1, "follower");
    const f = h.of("gw/a");
    f.emit({ connected: true, header: hdr, dbId: "db-1" });
    f.emit({ connected: false, lastError: "stream ended", failingSinceMs: h.now() });
    h.advance(STALE_MS);
    f.emit({ lastError: "stream ended" });
    await ticks();
    expect(h.kinds()).toEqual(["host.synced"]);
    h.advance(1);
    // The next discovery tick notices the follower has been failing too long.
    await until(() => h.hostEvents.length === 2, "sync_failed");
    expect(h.hostEvents[1]).toMatchObject({ kind: "host.sync_failed", payload: { remote: "lab", error: "stream ended" } });
    f.emit({ lastError: "stream ended" });
    await ticks();
    expect(h.hostEvents.length).toBe(2);
    f.emit({ lastError: "exited 255 before replication header" });
    expect(h.kinds()).toEqual(["host.synced", "host.sync_failed", "host.sync_failed"]);
    f.emit({ connected: true, lastError: null, failingSinceMs: null });
    expect(h.kinds()).toEqual(["host.synced", "host.sync_failed", "host.sync_failed", "host.synced"]);
    expect(h.store.getHost("gw/a")?.last_sync_ok).toBe(true);
    await h.stop();
  });

  test("a hung discovery does not delay stale detection", async () => {
    const h = harness();
    h.setListing([node("a")]);
    await until(() => h.followers.length === 1, "follower");
    h.setListing("hang");
    const f = h.of("gw/a");
    f.emit({ connected: true, header: hdr, dbId: "db-1" });
    f.emit({ connected: false, lastError: "stream ended", failingSinceMs: h.now() });
    await until(() => h.hangs() === 1, "hung listing");
    h.advance(STALE_MS + 1);
    await until(() => h.kinds().includes("host.sync_failed"), "sync_failed");
    expect(h.kinds()).toEqual(["host.synced", "host.sync_failed"]);
    await h.stop();
  });

  test("cursor moved then disconnect flushes the cursor once, at the transition", async () => {
    const h = harness();
    h.setListing([node("a")]);
    await until(() => h.followers.length === 1, "follower");
    const f = h.of("gw/a");
    f.emit({ connected: true, header: hdr, dbId: "db-1", cursor: 0 });
    for (let i = 1; i <= 5; i++) f.emit({ cursor: i });
    f.emit({ connected: false, lastError: "stream ended", failingSinceMs: h.now() });
    f.emit({ lastError: "exited 255 before replication header" });
    await ticks();
    expect(h.hostEvents.map((e) => [e.kind, (e.payload as any).cursor])).toEqual([["host.synced", 0], ["host.synced", 5]]);
    await h.stop();
    expect(h.hostEvents.length).toBe(2);
  });

  test("stop on a failing host writes no host.synced", async () => {
    const h = harness();
    h.setListing([node("a")]);
    await until(() => h.followers.length === 1, "follower");
    const f = h.of("gw/a");
    f.emit({ connected: true, header: hdr, dbId: "db-1", cursor: 0 });
    f.emit({ connected: false, lastError: "stream ended", failingSinceMs: h.now() });
    h.advance(STALE_MS + 1);
    await until(() => h.kinds().includes("host.sync_failed"), "sync_failed");
    f.emit({ cursor: 3 });   // e.g. a db reset while failing: the cursor moved, the host is not ok
    await h.stop();
    expect(h.kinds()).toEqual(["host.synced", "host.sync_failed"]);
    expect(h.store.getHost("gw/a")).toMatchObject({ last_sync_ok: false, last_error: "stream ended", cursor: 0 });
  });

  test("permanent error is reported immediately", async () => {
    const h = harness();
    h.setListing([node("a")]);
    await until(() => h.followers.length === 1, "follower");
    h.of("gw/a").emit({ lastError: "replication 2 unsupported", permanent: true, failingSinceMs: h.now() });
    expect(h.hostEvents.map((e) => [e.kind, e.payload])).toEqual([
      ["host.sync_failed", { remote: "lab", error: "replication 2 unsupported" }],
    ]);
    expect(h.store.getHost("gw/a")).toMatchObject({ remote: "lab", last_sync_ok: false });
    await h.stop();
  });

  test("stop flushes a moved cursor and stops every follower", async () => {
    const h = harness();
    h.setListing([node("a"), node("b")]);
    await until(() => h.followers.length === 2, "followers");
    h.of("gw/a").emit({ connected: true, header: hdr, dbId: "db-1", cursor: 1 });
    h.of("gw/a").emit({ cursor: 9 });
    h.of("gw/b").emit({ connected: true, header: { ...hdr, host: "gw/b" }, dbId: "db-1", cursor: 3 });
    await h.stop();
    expect(h.hostEvents.map((e) => [e.kind, e.host, (e.payload as any).cursor])).toEqual([
      ["host.synced", "gw/a", 1], ["host.synced", "gw/b", 3], ["host.synced", "gw/a", 9],
    ]);
    expect(h.followers.map((f) => f.stopped)).toEqual([1, 1]);
    const lists = h.lists();
    await ticks();
    expect(h.lists()).toBe(lists);
  });

  test("no remotes → no timers, stop resolves", async () => {
    const h = harness({ remotes: [] });
    await ticks();
    expect(h.lists()).toBe(0);
    await h.stop();
  });
});
