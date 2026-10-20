import {
  NO_SESSION_ID, sanitizeRemoteText, type HostRemovedPayload, type HostSyncedPayload, type HostSyncFailedPayload,
  type RemoteSyncState, type ReplicationHeader,
} from "@agmux/protocol";
import type { Store } from "@agmux/store";
import type { RemoteConfig } from "./config.ts";
import { openshellDiscovery, runCapture, type DiscoveredNode, type Discovery } from "./discovery.ts";
import { startFollower, type Follower, type FollowerStatus } from "./follower.ts";
import { openshellTransport, type Transport } from "./transport.ts";

// Per [[remote]]: discover sandboxes every `interval` s and keep exactly one
// follower per discovered sandbox. Follower status becomes the host ledger —
// log-derived host.* events the `hosts` projection is built from:
//   host.synced       ok-state flips to ok; a moved cursor, debounced to CURSOR_FLUSH_MS and flushed
//                     when a connected follower starts failing or is stopped (never while failing)
//   host.sync_failed  permanent error, or failing for > STALE_AFTER_INTERVALS; once per distinct error
//   host.removed      the sandbox is missing from REMOVE_AFTER_MISSES consecutive successful listings

export const CURSOR_FLUSH_MS = 10_000;
export const STALE_AFTER_INTERVALS = 3;
// A transient empty listing (exit 0) must not flap a sandbox's sessions to lost.
export const REMOVE_AFTER_MISSES = 2;

export interface SyncOptions { store: Store; remotes: RemoteConfig[]; consumer: string; log(s: string): void }
export interface SyncDeps {
  discoveryFor?(r: RemoteConfig): Discovery;
  transportFor?(r: RemoteConfig): Transport;
  follower?: typeof startFollower;
  nowMs?(): number;
  newId?(): string;
}

interface NodeState {
  remote: RemoteConfig; node: DiscoveredNode; transport: Transport; follower: Follower;
  ok: boolean;                  // last ledger write said "synced" (false until the first header)
  flushedCursor: number; lastFlushMs: number;
  reportedError: string | null; // last error written as host.sync_failed
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// stop: stops every follower, flushes moved cursors and clears the timers.
// remotes: per-remote discovery state (the hub's stdio is not visible anywhere).
export interface SyncHandle { stop(): Promise<void>; remotes(): RemoteSyncState[] }

interface DiscoveryState { last_discovery_ts: string | null; last_discovery_error?: string }

export function startSync(o: SyncOptions, deps: SyncDeps = {}): SyncHandle {
  const discoveryFor = deps.discoveryFor ?? ((r) => openshellDiscovery(r, (argv) => runCapture(argv)));
  const transportFor = deps.transportFor ?? openshellTransport;
  const follow = deps.follower ?? startFollower;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const nodes = new Map<string, NodeState>();   // by host, across all remotes
  const removals = new Map<string, Promise<void>>(); // by host, while in flight
  const timers: ReturnType<typeof setInterval>[] = [];
  const discoveries = new Map<RemoteConfig, DiscoveryState>();
  let stopped = false;

  // False (logged) when the store refused the write.
  function append(host: string, kind: string, payload: unknown): boolean {
    try {
      o.store.append({
        event_id: newId(), ts: new Date(nowMs()).toISOString(), session_id: NO_SESSION_ID,
        kind, version: 1, host, payload, dedup_key: null,
      });
      return true;
    } catch (e) {
      o.log(`sync: ${host}: writing ${kind} failed: ${errMsg(e)}`);
      return false;
    }
  }

  function writeSynced(ns: NodeState, s: FollowerStatus, h: ReplicationHeader): void {
    const payload: HostSyncedPayload = {
      remote: ns.remote.name, transport: ns.transport.spec(ns.node.target), cursor: s.cursor,
      db_id: h.db_id, agmux_version: sanitizeRemoteText(h.agmux), replication: h.replication, rejected: s.rejected,
    };
    // Only a written host.synced makes the node ok: until then its follower is not
    // ready, so no record is ingested without a hosts row (which would read as local).
    if (!append(ns.node.host, "host.synced", payload)) return;
    Object.assign(ns, { ok: true, flushedCursor: s.cursor, lastFlushMs: nowMs(), reportedError: null });
  }

  // Runs on every follower change and on every discovery tick (which makes the
  // debounce and the staleness check fire even when the follower is quiet).
  function ledger(ns: NodeState, s: FollowerStatus): void {
    const now = nowMs();
    if (s.connected && s.header) {
      const flushDue = s.cursor !== ns.flushedCursor && now - ns.lastFlushMs >= CURSOR_FLUSH_MS;
      if (!ns.ok || flushDue) writeSynced(ns, s, s.header);
      return;
    }
    // Connected → failing: persist the progress made on the connection that just ended.
    // (Not on a db reset, where the stale header's db_id no longer matches.)
    if (ns.ok && s.header && s.header.db_id === s.dbId && s.cursor !== ns.flushedCursor) writeSynced(ns, s, s.header);
    ns.ok = false;
    if (s.lastError === null || s.lastError === ns.reportedError) return;
    const staleMs = STALE_AFTER_INTERVALS * ns.remote.interval * 1000;
    if (s.permanent || (s.failingSinceMs !== null && now - s.failingSinceMs > staleMs)) {
      const payload: HostSyncFailedPayload = { remote: ns.remote.name, error: sanitizeRemoteText(s.lastError) };
      append(ns.node.host, "host.sync_failed", payload);
      ns.reportedError = s.lastError;
      o.log(`sync: ${ns.node.host}: ${s.lastError}`);
    }
  }

  function start(r: RemoteConfig, node: DiscoveredNode): void {
    const row = o.store.getHost(node.host);
    const cursor = row?.cursor ?? 0;
    const transport = transportFor(r);
    let ns: NodeState | undefined;
    const follower = follow({
      store: o.store, node, transport, agmuxBin: r.agmux_bin, consumer: o.consumer,
      cursor, dbId: row?.db_id ?? null, intervalMs: r.interval * 1000,
      onChange: (s) => { if (ns && !stopped && nodes.get(node.host) === ns) ledger(ns, s); },
      ready: () => ns?.ok ?? false,
    });
    ns = { remote: r, node, transport, follower, ok: false, flushedCursor: cursor, lastFlushMs: nowMs(), reportedError: null };
    nodes.set(node.host, ns);
  }

  // Stops the follower; if it was healthy and its cursor moved since the last flush,
  // writes a final host.synced. A failing host is left failing (its stale overlay stays).
  async function stopNode(ns: NodeState): Promise<void> {
    await ns.follower.stop();
    const s = ns.follower.status();
    if (ns.ok && s.connected && s.header && s.cursor !== ns.flushedCursor) writeSynced(ns, s, s.header);
  }

  async function remove(r: RemoteConfig, host: string): Promise<void> {
    const ns = nodes.get(host);
    if (ns) { nodes.delete(host); await stopNode(ns); }
    const row = o.store.getHost(host);
    if (row?.remote !== r.name || row.removed_ts !== null) return;
    const payload: HostRemovedPayload = { remote: r.name };
    append(host, "host.removed", payload);
    o.log(`sync: ${host}: removed (gone from ${r.name})`);
  }

  // misses: per host, how many consecutive successful listings of this remote lacked it.
  function reconcile(r: RemoteConfig, listed: DiscoveredNode[], misses: Map<string, number>): void {
    const seen = new Set(listed.map((n) => n.host));
    // A host still being removed is (re)started by a later tick.
    for (const n of listed) if (!nodes.has(n.host) && !removals.has(n.host)) start(r, n);
    const missing = new Set<string>();
    for (const [host, ns] of nodes) if (ns.remote === r && !seen.has(host)) missing.add(host);
    for (const row of o.store.listHosts()) {
      if (row.remote === r.name && row.removed_ts === null && !seen.has(row.host)) missing.add(row.host);
    }
    for (const host of misses.keys()) if (!missing.has(host)) misses.delete(host);
    for (const host of missing) {
      const n = (misses.get(host) ?? 0) + 1;
      misses.set(host, n);
      if (n < REMOVE_AFTER_MISSES || removals.has(host)) continue;
      misses.delete(host);
      const p = remove(r, host)
        .catch((e) => o.log(`sync: ${host}: removal failed: ${errMsg(e)}`))
        .finally(() => removals.delete(host));
      removals.set(host, p);
    }
  }

  function runRemote(r: RemoteConfig): void {
    const discovery = discoveryFor(r);
    const misses = new Map<string, number>();
    const state: DiscoveryState = { last_discovery_ts: null };
    discoveries.set(r, state);
    let busy = false;
    let lastError: string | null = null;
    const discover = async () => {
      busy = true;
      try {
        let listed: DiscoveredNode[];
        try {
          listed = await discovery.list();
        } catch (e) {
          const msg = errMsg(e);
          if (msg !== lastError) o.log(`sync: ${r.name}: discovery failed: ${msg}`);
          lastError = msg;
          Object.assign(state, { last_discovery_ts: new Date(nowMs()).toISOString(), last_discovery_error: sanitizeRemoteText(msg) });
          return;
        }
        lastError = null;
        state.last_discovery_ts = new Date(nowMs()).toISOString();
        delete state.last_discovery_error;
        if (!stopped) reconcile(r, listed, misses);
      } catch (e) {
        o.log(`sync: ${r.name}: ${errMsg(e)}`);   // never crash the hub
      } finally {
        busy = false;
      }
    };
    // The ledger pass runs every tick, even while a slow `sandbox list` is still in flight.
    const tick = () => {
      if (stopped) return;
      try {
        for (const ns of nodes.values()) if (ns.remote === r) ledger(ns, ns.follower.status());
      } catch (e) {
        o.log(`sync: ${r.name}: ${errMsg(e)}`);
      }
      if (!busy) void discover();
    };
    tick();
    timers.push(setInterval(tick, r.interval * 1000));
  }

  for (const r of o.remotes) runRemote(r);

  const remotes = (): RemoteSyncState[] => o.remotes.map((r) => ({
    name: r.name, gateway: r.gateway, ...discoveries.get(r)!,
    nodes: [...nodes.values()].filter((ns) => ns.remote === r).length,
  }));

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearInterval(t);
    const all = [...nodes.values()];
    nodes.clear();
    await Promise.all([...removals.values(), ...all.map((ns) => stopNode(ns).catch((e) =>
      o.log(`sync: ${ns.node.host}: stop failed: ${errMsg(e)}`)))]);
  };
  return { stop, remotes };
}
