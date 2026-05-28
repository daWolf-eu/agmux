import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";

test("runMigrations on empty db creates schema and stamps version", () => {
  const db = new Database(":memory:");
  const r = runMigrations(db);
  expect(r.from).toBe(0);
  expect(r.to).toBe(1);

  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all().map((r) => r.name);
  expect(tables).toContain("events");
  expect(tables).toContain("sessions");
  expect(tables).toContain("_meta");

  const v = db.query<{ value: string }, []>(`SELECT value FROM _meta WHERE key='schema_version'`).get();
  expect(v?.value).toBe("1");
});

test("runMigrations is idempotent", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const r2 = runMigrations(db);
  expect(r2.from).toBe(1);
  expect(r2.to).toBe(1);
});
