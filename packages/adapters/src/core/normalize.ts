import { ulid } from "ulid";
import type { EventEnvelope, IngestEnvelope, AgentKind } from "@agmux/protocol";
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

export interface StampIngestOpts {
  agentKind: AgentKind;
  nativeId: string | null;   // the agent's own native id, if known
  claimId: string | null;    // AGMUX_SESSION_ID (wrapper bridge), if set
  host: string;
  now?: () => string;
  newId?: () => string;
}

// Wrap canonical events into WIRE envelopes (spec §2). When a native id is known
// the event names itself natively (identity + claim hint); otherwise it falls
// back to the canonical session_id (claimId). Callers must ensure at least one of
// nativeId/claimId is set (emit drops otherwise).
export function stampIngestEvents(events: CanonicalEvent[], opts: StampIngestOpts): IngestEnvelope[] {
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? (() => ulid());
  return events.map((e) => {
    const base = {
      event_id: newId(), ts: now(), kind: e.kind, version: 1, host: opts.host,
      payload: e.payload, dedup_key: e.dedup_key ?? null,
    };
    if (opts.nativeId) {
      return { ...base, identity: { agent_kind: opts.agentKind, native_session_id: opts.nativeId }, claim_session_id: opts.claimId ?? null };
    }
    return { ...base, session_id: opts.claimId };
  });
}
