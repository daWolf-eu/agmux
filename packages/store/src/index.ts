import { Database } from "bun:sqlite";
import type { EventEnvelope, SessionRow } from "@agmux/protocol";
import { runMigrations } from "./migrations.ts";
import { applyEventToProjection } from "./project.ts";
import { getSessionRaw, listSessions, listEvents, getSessionUsage, type ListSessionsOpts, type ListEventsOpts, type SessionUsageRow } from "./queries.ts";
import { resolveIngest, type IngestEnvelopeLike } from "./resolve.ts";

export class Store {
  private db: Database;
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
        if (msg.includes("UNIQUE")) return false;
        throw e;
      }
      applyEventToProjection(this.db, ev);
      return true;
    });
    return tx();
  }

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

  getSession(sid: string, now: Date = new Date()): SessionRow | null {
    return getSessionRaw(this.db, sid, now);
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

  rebuildProjections(): void {
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM sessions`);
      this.db.exec(`DELETE FROM session_usage`);
      const rows = this.db.query<any, []>(
        `SELECT event_id, ts, session_id, kind, version, payload, host FROM events ORDER BY id ASC`
      ).all();
      for (const r of rows) {
        applyEventToProjection(this.db, {
          event_id: r.event_id, ts: r.ts, session_id: r.session_id, kind: r.kind,
          version: r.version, host: r.host, payload: JSON.parse(r.payload),
        });
      }
    })();
  }

  rawDb(): Database { return this.db; }

  close(): void { this.db.close(); }
}

export { resolveIngest, type IngestEnvelopeLike, type ResolveResult } from "./resolve.ts";
