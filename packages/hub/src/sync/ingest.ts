import {
  REPLICATION_VERSION, validateEnvelope, validateKnownPayload,
  type EventEnvelope, type ReplicationHeader, type ReplicationRecord,
} from "@agmux/protocol";
import type { Store } from "@agmux/store";

// Sandbox output is untrusted: everything here is validated before it can reach
// the store. A forged event must never touch a local session or land under a
// host other than the sandbox it came from.

export type StreamLine =
  | { type: "header"; header: ReplicationHeader }
  | { type: "record"; record: ReplicationRecord }
  | { type: "keepalive" }
  | { type: "invalid"; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export function parseStreamLine(line: string): StreamLine {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return { type: "invalid", reason: "not JSON" }; }
  if (!isObj(v)) return { type: "invalid", reason: "not an object" };
  if ("keepalive" in v) return { type: "keepalive" };
  if ("replication" in v) {
    const r = v.replication;
    if (typeof r !== "number" || !Number.isInteger(r) || r < 1) return { type: "invalid", reason: "header: bad replication" };
    if (!isStr(v.agmux) || !isStr(v.db_id) || !isStr(v.host)) return { type: "invalid", reason: "header: agmux, db_id and host must be strings" };
    return { type: "header", header: { replication: r, agmux: v.agmux, db_id: v.db_id, host: v.host } };
  }
  if ("id" in v || "ev" in v) {
    if (typeof v.id !== "number" || !Number.isSafeInteger(v.id) || v.id < 1) return { type: "invalid", reason: "record: bad id" };
    if (!isObj(v.ev)) return { type: "invalid", reason: "record: ev not an object" };
    return { type: "record", record: { id: v.id, ev: v.ev as unknown as EventEnvelope } };
  }
  return { type: "invalid", reason: "unrecognized line" };
}

export type IngestOutcome = { ok: true; appended: boolean } | { ok: false; reason: string };

export function ingestReplicated(store: Store, rec: ReplicationRecord, expectedHost: string): IngestOutcome {
  const ev = rec.ev;
  const env = validateEnvelope(ev);
  if (!env.ok) return { ok: false, reason: `invalid envelope: ${env.error}` };
  if (ev.kind.startsWith("host.")) return { ok: false, reason: `host event: ${ev.kind} is hub-local` };
  if (ev.host !== expectedHost) return { ok: false, reason: `host mismatch: event host "${ev.host}", expected "${expectedHost}"` };
  const p = validateKnownPayload(ev.kind, ev.payload);
  if (!p.ok) return { ok: false, reason: `invalid payload: ${p.error}` };
  const owner = store.sessionHost(ev.session_id);
  if (owner !== null && owner !== expectedHost) {
    return { ok: false, reason: `foreign session: ${ev.session_id} belongs to host "${owner}"` };
  }
  return { ok: true, appended: store.appendReplicated(ev, expectedHost) };
}

export function checkHeader(h: ReplicationHeader, expectedHost: string):
  { ok: true; newer: boolean } | { ok: false; error: string } {
  if (h.host !== expectedHost) {
    return { ok: false, error: `sandbox stamps host "${h.host}", expected "${expectedHost}" — create the sandbox with --env AGMUX_HOST=${expectedHost}` };
  }
  return { ok: true, newer: h.replication > REPLICATION_VERSION };
}
