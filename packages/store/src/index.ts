import { Database } from "bun:sqlite";
import type { EventEnvelope, HostRow, ReplicationRecord, SessionRow, StatusDecision } from "@agmux/protocol";
import { runMigrations } from "./migrations.ts";
import { applyEventToProjection, applySourceDb } from "./project.ts";
import { getSessionRaw, explainSession, listSessions, listEvents, getSessionUsage, listLiveNativeSessions, type ListSessionsOpts, type ListEventsOpts, type SessionUsageRow } from "./queries.ts";
import { getHost, listHosts } from "./hosts.ts";
import { resolveIngest, type IngestEnvelopeLike } from "./resolve.ts";

export class Store {
  private db: Database;
  private cachedDbId: string | null = null;
  private constructor(db: Database) {
    this.db = db;
    runMigrations(db);
  }
  static open(path: string): Store { return new Store(new Database(path, { create: true })); }
  static openInMemory(): Store { return new Store(new Database(":memory:")); }

  /** Returns true if the event was inserted, false if it was a duplicate event_id. */
  append(ev: EventEnvelope): boolean {
    const tx = this.db.transaction(() => {
      try {
        this.db.query(`
          INSERT INTO events (event_id, ts, session_id, kind, version, payload, host, dedup_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ev.event_id, ev.ts, ev.session_id, ev.kind, ev.version,
          JSON.stringify(ev.payload), ev.host, ev.dedup_key ?? null,
        );
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // Either a replayed event_id (transport retry) or a repeated dedup_key
        // (source observed the same fact twice) — both mean "already have it".
        // Exception: session.registered re-applies its projection even on dedup
        // because re-registration is idempotent and must reopen a lost session.
        if (msg.includes("UNIQUE")) {
          if (ev.kind === "session.registered") applyEventToProjection(this.db, ev);
          return false;
        }
        throw e;
      }
      applyEventToProjection(this.db, ev);
      return true;
    });
    return tx();
  }

  /**
   * Ingest an event replicated from another host. Idempotent on event_id; the
   * source's dedup_key is dropped (it only has meaning on the source) and the
   * row is tagged so it is never re-exported. A duplicate does not re-apply
   * the projection. `sourceDb` is the source store's db_id (its incarnation).
   * Returns true if inserted.
   */
  appendReplicated(ev: EventEnvelope, source: string, sourceDb: string): boolean {
    return this.db.transaction(() => {
      const r = this.db.query(`
        INSERT INTO events (event_id, ts, session_id, kind, version, payload, host, dedup_key, source, source_db)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `).run(
        ev.event_id, ev.ts, ev.session_id, ev.kind, ev.version,
        JSON.stringify(ev.payload), ev.host, source, sourceDb,
      );
      if (r.changes === 0) return false;
      applyEventToProjection(this.db, ev);
      applySourceDb(this.db, ev.session_id, sourceDb);
      return true;
    })();
  }

  /** Locally-ingested events after rowid `afterId`, oldest first (replicated rows excluded). */
  listExportable(afterId: number, limit: number): { records: ReplicationRecord[]; last_id: number } {
    const rows = this.db.query<any, [number, number]>(`
      SELECT id, event_id, ts, session_id, kind, version, payload, host, dedup_key
      FROM events WHERE id > ? AND source IS NULL ORDER BY id ASC LIMIT ?
    `).all(afterId, limit);
    const records: ReplicationRecord[] = rows.map((r) => ({
      id: r.id,
      ev: {
        event_id: r.event_id, ts: r.ts, session_id: r.session_id, kind: r.kind,
        version: r.version, host: r.host, payload: JSON.parse(r.payload),
        ...(r.dedup_key != null ? { dedup_key: r.dedup_key } : {}),
      },
    }));
    return { records, last_id: records.length ? records[records.length - 1]!.id : afterId };
  }

  /** Stable per-store identity, minted on first use; cached (it never changes for a file). */
  dbId(): string {
    this.cachedDbId ??= this.db.transaction(() => {
      const row = this.db.query<{ value: string }, []>(`SELECT value FROM _meta WHERE key = 'db_id'`).get();
      if (row) return row.value;
      const id = crypto.randomUUID();
      this.db.query(`INSERT INTO _meta(key, value) VALUES ('db_id', ?)`).run(id);
      return id;
    }).immediate();
    return this.cachedDbId;
  }

  getHost(host: string): HostRow | null { return getHost(this.db, host); }
  listHosts(): HostRow[] { return listHosts(this.db); }

  /**
   * Resolve a wire envelope to a canonical session and append it. Native-form
   * events are mapped via resolveIngest (spec §2.3); unresolvable telemetry is
   * dropped. Returns true if an event was appended (false on drop OR dedup).
   */
  resolveAndAppend(ing: IngestEnvelopeLike): boolean {
    const r = resolveIngest(this.db, ing);
    if (r.action === "drop") return false;
    return this.append(r.ev);
  }

  /** Host a session row belongs to, or null if the session is unknown. */
  sessionHost(sid: string): string | null {
    const r = this.db.query<{ host: string }, [string]>("SELECT host FROM sessions WHERE session_id = ?").get(sid);
    return r ? r.host : null;
  }

  getSession(sid: string, now: Date = new Date()): SessionRow | null {
    return getSessionRaw(this.db, sid, now);
  }

  explainSession(sid: string, now: Date = new Date()): StatusDecision | null {
    return explainSession(this.db, sid, now);
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRow[] {
    return listSessions(this.db, opts);
  }

  listEvents(opts: ListEventsOpts = {}): EventEnvelope[] {
    return listEvents(this.db, opts);
  }

  getSessionUsage(sid: string): SessionUsageRow | null {
    return getSessionUsage(this.db, sid);
  }

  listLiveNativeSessions(host: string): { session_id: string; pid: number }[] {
    return listLiveNativeSessions(this.db, host);
  }

  rebuildProjections(): void {
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM sessions`);
      this.db.exec(`DELETE FROM session_usage`);
      this.db.exec(`DELETE FROM session_activity`);
      this.db.exec(`DELETE FROM session_seen`);
      this.db.exec(`DELETE FROM session_meta`);
      this.db.exec(`DELETE FROM hosts`);
      const rows = this.db.query<any, []>(
        `SELECT event_id, ts, session_id, kind, version, payload, host, source_db FROM events ORDER BY id ASC`
      ).all();
      for (const r of rows) {
        applyEventToProjection(this.db, {
          event_id: r.event_id, ts: r.ts, session_id: r.session_id, kind: r.kind,
          version: r.version, host: r.host, payload: JSON.parse(r.payload),
        });
        if (r.source_db != null) applySourceDb(this.db, r.session_id, r.source_db);
      }
    })();
  }

  rawDb(): Database { return this.db; }

  close(): void { this.db.close(); }
}

export { resolveIngest, type IngestEnvelopeLike, type ResolveResult } from "./resolve.ts";
