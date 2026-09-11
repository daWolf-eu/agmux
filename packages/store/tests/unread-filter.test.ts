import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { listSessions } from "../src/queries.ts";

function seed(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  for (const id of ["s1", "s2"]) {
    applyEventToProjection(db, {
      event_id: `e-${id}`, ts: "2026-09-11T10:00:00.000Z", session_id: id, kind: "session.started",
      version: 1, host: "h",
      payload: { agent_kind: "claude", command: "claude", args: [], env_overrides: {}, cwd: "/tmp", host: "h" },
    } as any);
  }
  applyEventToProjection(db, {
    event_id: "e-r", ts: "2026-09-11T10:01:00.000Z", session_id: "s2", kind: "input.required",
    version: 1, host: "h", payload: { kind: "permission" },
  } as any);
  return db;
}

test("unread:true returns only sessions wanting attention", () => {
  const rows = listSessions(seed(), { unread: true });
  expect(rows.map((r) => r.session_id)).toEqual(["s2"]);
});

test("omitting the filter returns everything", () => {
  expect(listSessions(seed(), {}).length).toBe(2);
});
