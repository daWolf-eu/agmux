import type { Database } from "bun:sqlite";
import type { EventEnvelope, SessionStatus } from "@agmux/protocol";
import { LIVE_STATUSES, mintSessionId } from "@agmux/protocol";

// The wire shape accepted at ingest (structurally an IngestEnvelope; kept local
// and permissive so the store needn't depend on the exact protocol generic).
export interface IngestEnvelopeLike {
  event_id: string;
  ts: string;
  kind: string;
  version: number;
  host: string;
  payload: any;
  dedup_key?: string | null;
  session_id?: string | null;
  identity?: { agent_kind: string; native_session_id: string } | null;
  claim_session_id?: string | null;
}

export type ResolveResult =
  | { action: "append"; ev: EventEnvelope }
  | { action: "drop"; reason: string };

function toStorage(ing: IngestEnvelopeLike, sessionId: string): EventEnvelope {
  return {
    event_id: ing.event_id, ts: ing.ts, session_id: sessionId, kind: ing.kind,
    version: ing.version, host: ing.host, payload: ing.payload, dedup_key: ing.dedup_key ?? null,
  };
}

const isLive = (s: string): boolean => (LIVE_STATUSES as readonly string[]).includes(s);

// Pick the canonical session_id for a wire envelope (spec §2.3). READ-ONLY: it
// only decides the id; the projection (applyRegistered) does the writes. The four
// ordered rules apply to native-form registrations; non-registration native
// events resolve by rule 1 only and are otherwise dropped.
export function resolveIngest(
  db: Database,
  ing: IngestEnvelopeLike,
  deps: { newSessionId?: () => string } = {},
): ResolveResult {
  if (ing.session_id) return { action: "append", ev: toStorage(ing, ing.session_id) };

  const id = ing.identity;
  if (!id) return { action: "drop", reason: "envelope has neither session_id nor identity" };
  const K = id.agent_kind, N = id.native_session_id, H = ing.host;

  // Rule 1 — Known.
  const known = db.query<{ session_id: string }, [string, string, string]>(
    `SELECT session_id FROM sessions WHERE agent_kind = ? AND native_session_id = ? AND host = ?`,
  ).get(K, N, H);
  if (known) return { action: "append", ev: toStorage(ing, known.session_id) };

  if (ing.kind !== "session.registered") {
    return { action: "drop", reason: "native telemetry for an unregistered session" };
  }

  // Rule 2 — Claim (wrapped bridge): adopt a live, same-kind session whose native
  // id is still null. A stale inherited env (the summarizer) names a session that
  // already has a DIFFERENT native id, so it fails this rule and falls through.
  const C = ing.claim_session_id ?? null;
  if (C) {
    const t = db.query<{ status: SessionStatus; agent_kind: string; native_session_id: string | null }, [string]>(
      `SELECT status, agent_kind, native_session_id FROM sessions WHERE session_id = ?`,
    ).get(C);
    if (t && isLive(t.status) && t.agent_kind === K && t.native_session_id == null) {
      return { action: "append", ev: toStorage(ing, C) };
    }
  }

  // Rule 3 — Pid rotation: a live (host, pid, kind) row whose native id differs
  // (/clear or compaction rotated the native id in-process) → adopt it.
  const pid = typeof ing.payload?.pid === "number" ? ing.payload.pid : null;
  if (pid != null) {
    const placeholders = LIVE_STATUSES.map(() => "?").join(", ");
    const rot = db.query<{ session_id: string }, any[]>(
      `SELECT session_id FROM sessions
         WHERE host = ? AND pid = ? AND agent_kind = ? AND status IN (${placeholders})
           AND (native_session_id IS NULL OR native_session_id <> ?)
         ORDER BY start_ts DESC LIMIT 1`,
    ).get(H, pid, K, ...LIVE_STATUSES, N);
    if (rot) return { action: "append", ev: toStorage(ing, rot.session_id) };
  }

  // Rule 4 — Mint.
  const sid = (deps.newSessionId ?? mintSessionId)();
  return { action: "append", ev: toStorage(ing, sid) };
}
