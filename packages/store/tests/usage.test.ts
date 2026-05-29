import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { getSessionUsage } from "../src/queries.ts";

const sid = "0190a3e0-0000-7000-8000-000000000000";

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
    ts: "2026-05-28T12:00:00.000Z",
    session_id: sid, kind: "session.started", version: 1, host: "h",
    payload: {
      agent_kind: "codex", profile: null, command: "codex", args: [],
      env_overrides: {}, cwd: "/tmp", pid: 1, tmux_session: null,
      tmux_window: null, tmux_pane: null, project: null,
    },
  } as any);
  return db;
}

function usage(ts: string, payload: Record<string, unknown>) {
  return {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    ts, session_id: sid, kind: "usage.reported", version: 1, host: "h", payload,
  } as any;
}

test("delta usage accumulates across reports", () => {
  const db = freshDb();
  applyEventToProjection(db, usage("2026-05-28T12:01:00.000Z", { cumulative: false, source: "s", input_tokens: 100, output_tokens: 10 }));
  applyEventToProjection(db, usage("2026-05-28T12:02:00.000Z", { cumulative: false, source: "s", input_tokens: 50, output_tokens: 5 }));
  const u = getSessionUsage(db, sid)!;
  expect(u.input_tokens).toBe(150);
  expect(u.output_tokens).toBe(15);
});

test("cumulative usage replaces totals", () => {
  const db = freshDb();
  applyEventToProjection(db, usage("2026-05-28T12:01:00.000Z", { cumulative: true, source: "s", input_tokens: 100, model: "gpt" }));
  applyEventToProjection(db, usage("2026-05-28T12:02:00.000Z", { cumulative: true, source: "s", input_tokens: 250, model: "gpt" }));
  const u = getSessionUsage(db, sid)!;
  expect(u.input_tokens).toBe(250); // replaced, not summed
  expect(u.last_model).toBe("gpt");
});

test("rate_limit round-trips as decoded JSON", () => {
  const db = freshDb();
  applyEventToProjection(db, usage("2026-05-28T12:01:00.000Z", {
    cumulative: false, source: "s", rate_limit: { remaining: 42 },
  }));
  const u = getSessionUsage(db, sid)!;
  expect(u.last_rate_limit).toEqual({ remaining: 42 });
});
