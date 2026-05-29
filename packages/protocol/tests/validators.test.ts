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

test("validateKnownPayload accepts session.linked with native_session_id", () => {
  expect(validateKnownPayload("session.linked", { native_session_id: "abc" })).toEqual({ ok: true });
});

test("validateKnownPayload rejects session.linked missing native_session_id", () => {
  const r = validateKnownPayload("session.linked", {});
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/native_session_id/);
});

test("validateKnownPayload accepts turn.started with empty payload", () => {
  expect(validateKnownPayload("turn.started", {})).toEqual({ ok: true });
});

test("validateKnownPayload validates input.required kind enum", () => {
  expect(validateKnownPayload("input.required", { kind: "permission" })).toEqual({ ok: true });
  const r = validateKnownPayload("input.required", { kind: "bogus" });
  expect(r.ok).toBe(false);
});

test("validateKnownPayload requires usage.reported cumulative+source", () => {
  expect(validateKnownPayload("usage.reported", { cumulative: false, source: "transcript-delta", input_tokens: 10 })).toEqual({ ok: true });
  const r = validateKnownPayload("usage.reported", { input_tokens: 10 });
  expect(r.ok).toBe(false);
});

test("validateKnownPayload validates session.adapter_attached", () => {
  expect(validateKnownPayload("session.adapter_attached", {
    agent_kind: "codex", profile: null, adapter_version: "1", capabilities: {},
  })).toEqual({ ok: true });
  const r = validateKnownPayload("session.adapter_attached", {
    agent_kind: "nope", profile: null, adapter_version: "1", capabilities: {},
  });
  expect(r.ok).toBe(false);
});
