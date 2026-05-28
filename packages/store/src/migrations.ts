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

export function runMigrations(db: Database): { from: number; to: number } {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.query<{ value: string }, []>(`SELECT value FROM _meta WHERE key = 'schema_version'`).get();
  const current = row ? Number(row.value) : 0;
  const target = MIGRATIONS[MIGRATIONS.length - 1]!.version;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.transaction(() => {
        m.up(db);
        db.query(`INSERT INTO _meta(key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(m.version));
      })();
    }
  }
  return { from: current, to: target };
}
