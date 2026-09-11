import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { listSessions, getSessionRaw } from "../src/queries.ts";

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

test("getSessionRaw and listSessions report the same unread value (regression fence)", () => {
  const db = seed();
  const now = new Date();
  // s1 is read (no attention event), s2 is unread (has input.required)
  const s1Raw = getSessionRaw(db, "s1", now)!;
  const s1Listed = listSessions(db, {}).find((r) => r.session_id === "s1")!;
  expect(s1Raw.unread).toBe(s1Listed.unread);
  expect(s1Raw.unread).toBe(false);

  const s2Raw = getSessionRaw(db, "s2", now)!;
  const s2Listed = listSessions(db, {}).find((r) => r.session_id === "s2")!;
  expect(s2Raw.unread).toBe(s2Listed.unread);
  expect(s2Raw.unread).toBe(true);
});
