import type { Database } from "bun:sqlite";
import { SCHEMA_V1 } from "./schema.ts";

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1);
    },
  },
];

// Switching a fresh DB to WAL needs a brief exclusive lock, and SQLite's
// journal-mode change can return SQLITE_BUSY without honoring busy_timeout when
// two connections race (two hubs spawning at once). Retry briefly; if a peer
// already flipped it to WAL, our query just reads back "wal" and we're done.
function enableWal(db: Database): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (e: any) {
      if (Date.now() >= deadline || !String(e?.message ?? e).includes("locked")) throw e;
      Bun.sleepSync(20 + Math.floor(Math.random() * 30));
    }
  }
}

export function runMigrations(db: Database): { from: number; to: number } {
  // Wait (rather than erroring SQLITE_BUSY) when another connection holds a
  // lock — e.g. two hubs spawning concurrently both run migrations on open,
  // and setting WAL mode needs a brief exclusive lock. Persists per-connection,
  // so later queries inherit it too.
  db.exec("PRAGMA busy_timeout = 5000");
  enableWal(db);
  db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const target = MIGRATIONS[MIGRATIONS.length - 1]!.version;
  let from = 0;
  // IMMEDIATE so the version read + apply is one atomic critical section across
  // processes: a second hub spawning concurrently blocks here, then reads the
  // committed schema_version and skips — no double-apply, no half-built schema.
  const migrate = db.transaction(() => {
    const row = db.query<{ value: string }, []>(`SELECT value FROM _meta WHERE key = 'schema_version'`).get();
    from = row ? Number(row.value) : 0;
    for (const m of MIGRATIONS) {
      if (m.version > from) {
        m.up(db);
        db.query(`INSERT INTO _meta(key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(m.version));
      }
    }
  });
  migrate.immediate();
  return { from, to: target };
}
