import { test, expect } from "bun:test";
import { validateEnvelope, validateKnownPayload } from "../src/validators.ts";

const goodEnvelope = {
  event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
  ts: "2026-05-28T12:00:00.000Z",
  session_id: "0190a3e0-0000-7000-8000-000000000000",
  kind: "session.started",
  version: 1,
  host: "macbook.local",
  payload: {
    agent_kind: "claude",
    profile: "claude-work",
    command: "ccc",
    args: [],
    env_overrides: {},
    cwd: "/tmp",
    pid: 1234,
    tmux_session: "agmux",
    tmux_window: "@1",
    tmux_pane: "%1",
    project: null,
  },
};

test("validateEnvelope accepts a well-formed envelope", () => {
  expect(validateEnvelope(goodEnvelope)).toEqual({ ok: true });
});

test("validateEnvelope rejects missing required field", () => {
  const bad = { ...goodEnvelope, event_id: undefined };
  const r = validateEnvelope(bad);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/event_id/);
});

test("validateEnvelope accepts unknown kind (stored raw)", () => {
  const future = { ...goodEnvelope, kind: "turn.started", payload: { anything: 1 } };
  expect(validateEnvelope(future)).toEqual({ ok: true });
});

test("validateKnownPayload(session.started) accepts well-formed payload", () => {
  expect(validateKnownPayload("session.started", goodEnvelope.payload)).toEqual({ ok: true });
});

test("validateKnownPayload(session.ended) rejects bad reason", () => {
  const r = validateKnownPayload("session.ended", { exit_code: 0, signal: null, reason: "WAT" });
  expect(r.ok).toBe(false);
});

test("validateKnownPayload returns ok for unknown kinds (raw storage)", () => {
  expect(validateKnownPayload("turn.started", { foo: 1 })).toEqual({ ok: true });
});
