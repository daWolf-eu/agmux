import { ulid } from "ulid";
import type { EventEnvelope } from "@agmux/protocol";
import type { CanonicalEvent } from "./types.ts";

export interface StampOpts {
  sessionId: string;
  host: string;
  now?: () => string;     // injectable for deterministic tests
  newId?: () => string;   // injectable for deterministic tests
}

// Wrap an adapter's canonical events into fully-formed envelopes. version is
// always 1 (spec §3.3); dedup_key carries source-idempotency (spec §4.4) or null.
export function stampEvents(events: CanonicalEvent[], opts: StampOpts): EventEnvelope[] {
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? (() => ulid());
  return events.map((e) => ({
    event_id: newId(),
    ts: now(),
    session_id: opts.sessionId,
    kind: e.kind,
    version: 1,
    host: opts.host,
    payload: e.payload,
    dedup_key: e.dedup_key ?? null,
  }));
}
