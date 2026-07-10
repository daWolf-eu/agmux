import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const sid = "0190a3e0-0000-7000-8000-000000000000";

function startedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
    ts: "2026-05-28T12:00:00.000Z",
    session_id: sid,
    kind: "session.started",
    version: 1,
    host: "macbook.local",
    payload: {
      agent_kind: "claude",
      profile: "claude-work",
      command: "ccc",
      args: ["--foo"],
      env_overrides: { ANTHROPIC_LOG: "info" },
      cwd: "/tmp",
      pid: 4242,
      tmux_session: "agmux",
      tmux_window: "@1",
      tmux_pane: "%1",
      project: null,
    },
    ...overrides,
  };
}

test("session.started inserts a row with status='idle'", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  const row = db.query<any, []>(`SELECT * FROM sessions WHERE session_id='${sid}'`).get();
  expect(row?.status).toBe("idle");
  expect(row?.command).toBe("ccc");
  expect(JSON.parse(row?.args_json)).toEqual(["--foo"]);
  expect(row?.start_ts).toBe("2026-05-28T12:00:00.000Z");
});

test("session.heartbeat updates last_heartbeat_ts; status stays idle if was idle", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q",
    ts: "2026-05-28T12:00:30.000Z",
    session_id: sid,
    kind: "session.heartbeat",
    version: 1,
    host: "macbook.local",
    payload: { pid_alive: true, winsize: { rows: 40, cols: 100 } },
  });
  const row = db.query<any, []>(`SELECT * FROM sessions WHERE session_id='${sid}'`).get();
  expect(row.last_heartbeat_ts).toBe("2026-05-28T12:00:30.000Z");
  expect(row.status).toBe("idle");
});

test("session.ended sets status='ended', end_ts, exit_code, signal", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2R",
    ts: "2026-05-28T12:05:00.000Z",
    session_id: sid,
    kind: "session.ended",
    version: 1,
    host: "macbook.local",
    payload: { exit_code: 0, signal: null, reason: "normal" },
  });
  const row = db.query<any, []>(`SELECT * FROM sessions WHERE session_id='${sid}'`).get();
  expect(row.status).toBe("ended");
  expect(row.end_ts).toBe("2026-05-28T12:05:00.000Z");
  expect(row.exit_code).toBe(0);
});

test("session.resumed re-opens an ended row: status='idle', clears end_ts, updates pid+tmux", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2R",
    ts: "2026-05-28T12:05:00.000Z",
    session_id: sid, kind: "session.ended", version: 1, host: "macbook.local",
    payload: { exit_code: 0, signal: null, reason: "normal" },
  });
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2S",
    ts: "2026-05-28T12:10:00.000Z",
    session_id: sid, kind: "session.resumed", version: 1, host: "macbook.local",
    payload: {
      new_pid: 9999,
      new_tmux_session: "agmux",
      new_tmux_window: "@2",
      new_tmux_pane: "%2",
      reason: "cli_attach_after_death",
    },
  });
  const row = db.query<any, []>(`SELECT * FROM sessions WHERE session_id='${sid}'`).get();
  expect(row.status).toBe("idle");
  expect(row.end_ts).toBeNull();
  expect(row.pid).toBe(9999);
  expect(row.tmux_window).toBe("@2");
  // immutables preserved
  expect(row.start_ts).toBe("2026-05-28T12:00:00.000Z");
  expect(row.command).toBe("ccc");
});

test("unknown event kinds do not crash and do not update the projection", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2T",
    ts: "2026-05-28T12:06:00.000Z",
    session_id: sid, kind: "future.unknown.kind", version: 1, host: "macbook.local",
    payload: { anything: 1 },
  } as any);
  const row = db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get();
  expect(row.status).toBe("idle");
});

function ev(kind: string, ts: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    ts, session_id: sid, kind, version: 1, host: "h", payload, ...extra,
  } as any;
}

test("turn.started -> running, turn.ended -> idle", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("turn.started", "2026-05-28T12:01:00.000Z", {}));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("running");
  applyEventToProjection(db, ev("turn.ended", "2026-05-28T12:02:00.000Z", { reason: "done" }));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("idle");
});

test("input.required -> waiting, input.received -> running", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("input.required", "2026-05-28T12:01:00.000Z", { kind: "permission" }));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("waiting");
  applyEventToProjection(db, ev("input.received", "2026-05-28T12:01:30.000Z", {}));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("running");
});

test("live transition on an ended row is ignored (no resurrection)", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("session.ended", "2026-05-28T12:05:00.000Z", { exit_code: 0, signal: null, reason: "normal" }));
  applyEventToProjection(db, ev("turn.started", "2026-05-28T12:06:00.000Z", {}));
  expect(db.query<any, []>(`SELECT status FROM sessions WHERE session_id='${sid}'`).get().status).toBe("ended");
});

test("session.linked sets native_session_id", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("session.linked", "2026-05-28T12:01:00.000Z", { native_session_id: "codex-xyz" }));
  expect(db.query<any, []>(`SELECT native_session_id FROM sessions WHERE session_id='${sid}'`).get().native_session_id).toBe("codex-xyz");
});

test("session.adapter_attached records capabilities JSON", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  const caps = { "turn.started": { fulfil: "yes", source: "hook-command" } };
  applyEventToProjection(db, ev("session.adapter_attached", "2026-05-28T12:00:30.000Z", {
    agent_kind: "codex", profile: null, adapter_version: "1", capabilities: caps,
  }));
  const raw = db.query<any, []>(`SELECT adapter_capabilities FROM sessions WHERE session_id='${sid}'`).get();
  expect(JSON.parse(raw.adapter_capabilities)).toEqual(caps);
});

test("turn.started bumps session_usage.turn_count and creates the row", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("turn.started", "2026-05-28T12:01:00.000Z", {}));
  const u = db.query<any, []>(`SELECT turn_count FROM session_usage WHERE session_id='${sid}'`).get();
  expect(u.turn_count).toBe(1);
});

test("session.linked after session.ended is ignored (identity frozen on death)", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("session.linked", "2026-05-28T12:01:00.000Z", { native_session_id: "real-conversation" }));
  applyEventToProjection(db, ev("session.ended", "2026-05-28T12:05:00.000Z", { exit_code: 0, signal: null, reason: "normal" }));
  // e.g. a SessionEnd-hook summarizer (`claude -p`) inheriting AGMUX_SESSION_ID
  applyEventToProjection(db, ev("session.linked", "2026-05-28T12:05:02.000Z", { native_session_id: "summarizer-session" }));
  expect(db.query<any, []>(`SELECT native_session_id FROM sessions WHERE session_id='${sid}'`).get().native_session_id).toBe("real-conversation");
});

test("usage and turn_count after session.ended are ignored (telemetry frozen on death)", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("turn.started", "2026-05-28T12:01:00.000Z", {}));
  applyEventToProjection(db, ev("usage.reported", "2026-05-28T12:02:00.000Z", { cumulative: false, source: "s", input_tokens: 100 }));
  applyEventToProjection(db, ev("session.ended", "2026-05-28T12:05:00.000Z", { exit_code: 0, signal: null, reason: "normal" }));
  applyEventToProjection(db, ev("turn.started", "2026-05-28T12:05:02.000Z", {}));
  applyEventToProjection(db, ev("usage.reported", "2026-05-28T12:05:03.000Z", { cumulative: false, source: "s", input_tokens: 9999 }));
  const u = db.query<any, []>(`SELECT turn_count, input_tokens FROM session_usage WHERE session_id='${sid}'`).get();
  expect(u.turn_count).toBe(1);
  expect(u.input_tokens).toBe(100);
});

test("session.adapter_attached after session.ended is ignored", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  applyEventToProjection(db, ev("session.ended", "2026-05-28T12:05:00.000Z", { exit_code: 0, signal: null, reason: "normal" }));
  applyEventToProjection(db, ev("session.adapter_attached", "2026-05-28T12:05:02.000Z", {
    agent_kind: "claude", profile: null, adapter_version: "9", capabilities: { "turn.started": { fulfil: "yes" } },
  }));
  expect(db.query<any, []>(`SELECT adapter_capabilities FROM sessions WHERE session_id='${sid}'`).get().adapter_capabilities).toBeNull();
});

test("compaction is log-only: no projection side effects, session row untouched", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  const before = db.query<any, []>(`SELECT * FROM sessions WHERE session_id='${sid}'`).get();
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2R",
    ts: "2026-05-28T12:01:00.000Z",
    session_id: sid,
    kind: "compaction",
    version: 1,
    host: "macbook.local",
    payload: { trigger: "manual" },
  });
  const after = db.query<any, []>(`SELECT * FROM sessions WHERE session_id='${sid}'`).get();
  expect(after).toEqual(before); // projection unchanged — compaction only lives in the event log
});
