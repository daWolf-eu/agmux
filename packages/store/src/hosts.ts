import type { Database } from "bun:sqlite";
import type {
  EventEnvelope, HostRemovedPayload, HostRow, HostSyncFailedPayload, HostSyncedPayload,
} from "@agmux/protocol";

// Projection of host.* events (hub-authored by the sync loop), keyed by ev.host.
export function applyHostEvent(db: Database, ev: EventEnvelope): void {
  switch (ev.kind) {
    case "host.synced": {
      const p = ev.payload as HostSyncedPayload;
      db.query(`
        INSERT INTO hosts (host, remote, transport, last_sync_ts, last_sync_ok, last_error,
                           cursor, db_id, agmux_version, replication, rejected, removed_ts)
        VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(host) DO UPDATE SET
          remote = excluded.remote, transport = excluded.transport,
          last_sync_ts = excluded.last_sync_ts, last_sync_ok = 1, last_error = NULL,
          cursor = excluded.cursor, db_id = excluded.db_id,
          agmux_version = excluded.agmux_version, replication = excluded.replication,
          rejected = excluded.rejected, removed_ts = NULL
      `).run(
        ev.host, p.remote, JSON.stringify(p.transport), ev.ts,
        p.cursor, p.db_id, p.agmux_version, p.replication, p.rejected,
      );
      return;
    }
    case "host.sync_failed": {
      const p = ev.payload as HostSyncFailedPayload;
      db.query(`
        INSERT INTO hosts (host, remote, last_sync_ok, last_error) VALUES (?, ?, 0, ?)
        ON CONFLICT(host) DO UPDATE SET last_sync_ok = 0, last_error = excluded.last_error
      `).run(ev.host, p.remote, p.error);
      return;
    }
    case "host.removed": {
      const p = ev.payload as HostRemovedPayload;
      db.query(`
        INSERT INTO hosts (host, remote, removed_ts) VALUES (?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET removed_ts = excluded.removed_ts
      `).run(ev.host, p.remote, ev.ts);
      return;
    }
  }
}

function toRow(r: any): HostRow {
  return {
    host: r.host, remote: r.remote,
    transport: r.transport ? JSON.parse(r.transport) : null,
    last_sync_ts: r.last_sync_ts, last_sync_ok: r.last_sync_ok === 1, last_error: r.last_error,
    cursor: r.cursor, db_id: r.db_id, agmux_version: r.agmux_version,
    replication: r.replication, rejected: r.rejected, removed_ts: r.removed_ts,
  };
}

export function getHost(db: Database, host: string): HostRow | null {
  const r = db.query<any, [string]>(`SELECT * FROM hosts WHERE host = ?`).get(host);
  return r ? toRow(r) : null;
}

export function listHosts(db: Database): HostRow[] {
  return db.query<any, []>(`SELECT * FROM hosts ORDER BY host`).all().map(toRow);
}
