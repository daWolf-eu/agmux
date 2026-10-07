import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";

test("runMigrations on empty db creates schema and stamps version", () => {
  const db = new Database(":memory:");
  const r = runMigrations(db);
  expect(r.from).toBe(0);
  expect(r.to).toBe(7);

  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all().map((r) => r.name);
  expect(tables).toContain("events");
  expect(tables).toContain("sessions");
  expect(tables).toContain("_meta");

  const v = db.query<{ value: string }, []>(`SELECT value FROM _meta WHERE key='schema_version'`).get();
  expect(v?.value).toBe("7");
});

test("runMigrations is idempotent", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const r2 = runMigrations(db);
  expect(r2.from).toBe(7);
  expect(r2.to).toBe(7);
});

test("migration v2 creates session_usage, dedup_key column, and adapter_capabilities column", () => {
  const db = new Database(":memory:");
  runMigrations(db);

  const usageCols = db.query<any, []>(`PRAGMA table_info(session_usage)`).all();
  expect(usageCols.length).toBeGreaterThan(0);
  const usageNames = usageCols.map((c: any) => c.name);
  expect(usageNames).toContain("input_tokens");
  expect(usageNames).toContain("reasoning_output_tokens");
  expect(usageNames).toContain("turn_count");

  const eventCols = db.query<any, []>(`PRAGMA table_info(events)`).all().map((c: any) => c.name);
  expect(eventCols).toContain("dedup_key");

  const sessionCols = db.query<any, []>(`PRAGMA table_info(sessions)`).all().map((c: any) => c.name);
  expect(sessionCols).toContain("adapter_capabilities");

  const ver = db.query<{ value: string }, []>(`SELECT value FROM _meta WHERE key='schema_version'`).get();
  expect(Number(ver!.value)).toBe(7);
});

test("migration v3 adds sessions.origin defaulting to 'wrapper'", () => {
  const db = new Database(":memory:");
  const { to } = runMigrations(db);
  expect(to).toBe(7);
  const cols = db.query<{ name: string; dflt_value: string | null }, []>(`PRAGMA table_info(sessions)`).all();
  const origin = cols.find((c) => c.name === "origin");
  expect(origin).toBeDefined();
  expect(String(origin!.dflt_value)).toContain("wrapper");
});

test("migration v3 creates the native-identity resolver index", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const idx = db.query<{ name: string }, []>(`PRAGMA index_list(sessions)`).all();
  expect(idx.map((i) => i.name)).toContain("idx_native_identity");
});

test("resolver index allows many NULL native ids but rejects a duplicate (kind,native,host)", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const ins = (sid: string, nat: string | null) => db.query(`
    INSERT INTO sessions (session_id, agent_kind, profile, native_session_id, command, args_json, env_json, cwd, host, start_ts, status, origin)
    VALUES (?, 'claude', NULL, ?, 'c', '[]', '{}', '/tmp', 'h', '2026-06-08T00:00:00.000Z', 'idle', 'native')
  `).run(sid, nat);
  ins("s1", null); ins("s2", null);            // two NULLs: fine
  ins("s3", "n-1");
  expect(() => ins("s4", "n-1")).toThrow();     // duplicate (claude, n-1, h): rejected
});

test("v4 creates session_activity and bumps schema_version", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const version = db
    .query<{ value: string }, []>(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    .get();
  expect(version?.value).toBe("7");
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(session_activity)`).all()
    .map((c) => c.name);
  expect(cols).toEqual(["session_id", "last_tool", "last_tool_detail", "last_input_kind", "activity_ts", "attention_ts",
    "attention_kind", "title", "title_activity", "title_ts"]);
});

test("v6 creates session_seen and bumps schema_version", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const version = db
    .query<{ value: string }, []>(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    .get();
  expect(version?.value).toBe("7");
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(session_seen)`).all()
    .map((c) => c.name);
  expect(cols).toEqual(["session_id", "seen_ts", "seen_source"]);
});

test("an existing v5 database migrates cleanly to the latest (incremental step, not fresh-DB only)", () => {
  const db = new Database(":memory:");
  // Simulate a pre-existing database that only ran migrations 1-5.
  const { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5 } = require("../src/schema.ts");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.transaction(() => {
    db.exec(SCHEMA_V1);
    db.exec(SCHEMA_V2);
    db.exec(SCHEMA_V3);
    db.exec(SCHEMA_V4);
    db.exec(SCHEMA_V5);
    db.query(`INSERT INTO _meta(key, value) VALUES ('schema_version', '5')`).run();
  })();
  // Insert a row pre-migration to prove the ALTER TABLE step doesn't lose data.
  db.query(`
    INSERT INTO session_activity (session_id, last_tool, activity_ts) VALUES ('s-pre', 'Bash', '2026-01-01T00:00:00.000Z')
  `).run();

  const { from, to } = runMigrations(db);
  expect(from).toBe(5);
  expect(to).toBe(7);

  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all().map((r) => r.name);
  expect(tables).toContain("session_seen");

  const activityCols = db.query<{ name: string }, []>(`PRAGMA table_info(session_activity)`).all()
    .map((c) => c.name);
  expect(activityCols).toContain("attention_ts");

  const preRow = db.query<any, [string]>(`SELECT * FROM session_activity WHERE session_id = ?`).get("s-pre");
  expect(preRow.last_tool).toBe("Bash");
  expect(preRow.attention_ts).toBeNull();
});

test("v7 adds status/attention provenance, the title signal and seen_source", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const cols = (t: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  expect(cols("sessions")).toEqual(expect.arrayContaining(["status_kind", "status_ts"]));
  expect(cols("session_activity")).toEqual(expect.arrayContaining(["attention_kind", "title", "title_activity", "title_ts"]));
  expect(cols("session_seen")).toContain("seen_source");
});
