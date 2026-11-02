import { test, expect } from "bun:test";
import { buildStartedEvent, buildHeartbeatEvent, buildEndedEvent, buildResumedEvent } from "../src/lifecycle.ts";

test("buildStartedEvent has correct shape", () => {
  const ev = buildStartedEvent({
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
    host: "h",
    agent_kind: "claude",
    profile: "p",
    command: "ccc",
    args: ["-a"],
    env_overrides: { X: "1" },
    cwd: "/",
    pid: 42,
    tmux: { session: "agmux", window: "@1", pane: "%1", socket: null },
    project: null,
  });
  expect(ev.kind).toBe("session.started");
  expect(ev.payload.pid).toBe(42);
  expect(ev.event_id).toMatch(/^[0-9A-Z]{26}$/);
  expect(ev.session_id).toBe("0190a3e0-0000-7000-8000-000000000000");
});

test("buildHeartbeatEvent carries winsize", () => {
  const ev = buildHeartbeatEvent({ sessionId: "x", host: "h", pid: 42, rows: 40, cols: 100 });
  expect(ev.kind).toBe("session.heartbeat");
  expect(ev.payload.winsize).toEqual({ rows: 40, cols: 100 });
  expect(ev.payload.pid_alive).toBe(true);
});

test("buildEndedEvent reason='normal' when no signal", () => {
  const ev = buildEndedEvent({ sessionId: "x", host: "h", exitCode: 0, signal: null });
  expect(ev.payload.reason).toBe("normal");
});

test("buildEndedEvent reason='signal' when signal present", () => {
  const ev = buildEndedEvent({ sessionId: "x", host: "h", exitCode: null, signal: "SIGTERM" });
  expect(ev.payload.reason).toBe("signal");
});

test("buildEndedEvent reason='pane_closed' on SIGHUP-from-tmux explicit override", () => {
  const ev = buildEndedEvent({ sessionId: "x", host: "h", exitCode: null, signal: "SIGHUP", reasonOverride: "pane_closed" });
  expect(ev.payload.reason).toBe("pane_closed");
});

test("buildResumedEvent captures new pid + new tmux coords", () => {
  const ev = buildResumedEvent({ sessionId: "x", host: "h", newPid: 99, tmux: { session: "agmux", window: "@2", pane: "%2", socket: null } });
  expect(ev.kind).toBe("session.resumed");
  expect(ev.payload.new_pid).toBe(99);
  expect(ev.payload.new_tmux_window).toBe("@2");
});

test("buildStartedEvent and buildResumedEvent carry mux and label only when given", () => {
  const tmux = { session: "S", window: "W", pane: "B", socket: "srv" };
  const base = { sessionId: "x", host: "h", agent_kind: "claude" as const, profile: null, command: "c", args: [], env_overrides: {}, cwd: "/", pid: 1, tmux, project: null };
  const plain = buildStartedEvent(base).payload as any;
  expect("mux" in plain).toBe(false);
  expect("mux_label" in plain).toBe(false);
  const rex = buildStartedEvent({ ...base, mux: "rex", mux_label: "work" }).payload as any;
  expect(rex).toMatchObject({ mux: "rex", mux_label: "work" });
  const r0 = buildResumedEvent({ sessionId: "x", host: "h", newPid: 2, tmux }).payload as any;
  expect("new_mux" in r0).toBe(false);
  const r1 = buildResumedEvent({ sessionId: "x", host: "h", newPid: 2, tmux, mux: "rex", mux_label: "work" }).payload as any;
  expect(r1).toMatchObject({ new_mux: "rex", new_mux_label: "work" });
});
