import type { EventEnvelope } from "@agmux/protocol";
import { HEARTBEAT_INTERVAL_MS } from "@agmux/protocol";
import type { Store } from "@agmux/store";
import { isProcessAlive } from "./bootstrap.ts";

// Build the canonical session.lost observation appended when a native pid is gone.
export function buildLostEvent(o: { sessionId: string; host: string; now?: () => string; newId?: () => string }): EventEnvelope {
  const now = o.now ?? (() => new Date().toISOString());
  const newId = o.newId ?? (() => crypto.randomUUID());
  return {
    event_id: newId(), ts: now(), session_id: o.sessionId, kind: "session.lost",
    version: 1, host: o.host, payload: { reason: "pid_dead" }, dedup_key: null,
  };
}

// One sweep pass (spec §3): for every live native row on this host, kill -0 its
// pid; a dead pid appends session.lost. Returns the count newly marked lost.
// isAlive is injectable for tests. Pid reuse is an accepted v1 edge (spec §8).
export function sweepNativeLiveness(
  store: Store,
  o: { host: string; isAlive?: (pid: number) => boolean; now?: () => string },
): number {
  const isAlive = o.isAlive ?? isProcessAlive;
  let lost = 0;
  for (const r of store.listLiveNativeSessions(o.host)) {
    if (!isAlive(r.pid)) {
      store.append(buildLostEvent({ sessionId: r.session_id, host: o.host, now: o.now }));
      lost++;
    }
  }
  return lost;
}

// Start the periodic sweep. Returns a stop function. Errors in a pass are
// swallowed (a sweep failure must never crash the hub).
export function startNativeLivenessSweep(store: Store, host: string, intervalMs: number = HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    try { sweepNativeLiveness(store, { host }); } catch { /* never crash the hub */ }
  }, intervalMs);
  return () => clearInterval(timer);
}
