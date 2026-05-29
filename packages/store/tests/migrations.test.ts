import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";

test("runMigrations on empty db creates schema and stamps version", () => {
  const db = new Database(":memory:");
  const r = runMigrations(db);
  expect(r.from).toBe(0);
  expect(r.to).toBe(2);

  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all().map((r) => r.name);
  expect(tables).toContain("events");
  expect(tables).toContain("sessions");
  expect(tables).toContain("_meta");

  const v = db.query<{ value: string }, []>(`SELECT value FROM _meta WHERE key='schema_version'`).get();
  expect(v?.value).toBe("2");
});

test("runMigrations is idempotent", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const r2 = runMigrations(db);
  expect(r2.from).toBe(2);
  expect(r2.to).toBe(2);
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
  expect(Number(ver!.value)).toBe(2);
});
