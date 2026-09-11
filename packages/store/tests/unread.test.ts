import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { listSessions } from "../src/queries.ts";

function db0(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  applyEventToProjection(db, {
    event_id: "e0", ts: "2026-09-11T10:00:00.000Z", session_id: "s1", kind: "session.started",
    version: 1, host: "h",
    payload: { agent_kind: "claude", command: "claude", args: [], env_overrides: {}, cwd: "/tmp", host: "h" },
  } as any);
  return db;
}

function ev(db: Database, kind: string, ts: string, payload: any = {}) {
  applyEventToProjection(db, { event_id: `e-${ts}`, ts, session_id: "s1", kind, version: 1, host: "h", payload } as any);
}

test("a fresh session with no attention event is not unread", () => {
  const db = db0();
  expect(listSessions(db, {})[0]!.unread).toBe(false);
});

test("input.required makes a session unread", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  expect(listSessions(db, {})[0]!.unread).toBe(true);
});

test("a later session.seen clears it", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  ev(db, "session.seen", "2026-09-11T10:02:00.000Z", { source: "attach" });
  expect(listSessions(db, {})[0]!.unread).toBe(false);
});

test("a new attention event after being seen makes it unread again", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  ev(db, "session.seen", "2026-09-11T10:02:00.000Z", { source: "attach" });
  ev(db, "turn.ended", "2026-09-11T10:03:00.000Z", {});
  expect(listSessions(db, {})[0]!.unread).toBe(true);
});

test("tool.used does NOT make a session unread", () => {
  const db = db0();
  ev(db, "tool.used", "2026-09-11T10:01:00.000Z", { tool: "Bash", detail: "ls" });
  expect(listSessions(db, {})[0]!.unread).toBe(false);
});

test("an out-of-order seen event never moves the marker backwards", () => {
  const db = db0();
  ev(db, "session.seen", "2026-09-11T10:05:00.000Z", { source: "dismiss" });
  ev(db, "session.seen", "2026-09-11T10:01:00.000Z", { source: "attach" });
  ev(db, "turn.ended", "2026-09-11T10:03:00.000Z", {});
  expect(listSessions(db, {})[0]!.unread).toBe(false);
});
