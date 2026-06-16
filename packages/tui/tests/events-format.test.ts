import { test, expect } from "bun:test";
import type { EventEnvelope } from "@agmux/protocol";
import { eventLines } from "../src/events-format.ts";

function ev(kind: string, payload: unknown, ts = "2026-06-11T12:05:11.000Z"): EventEnvelope {
  return { event_id: "01", ts, session_id: "s", kind, version: 1, host: "h", payload };
}

test("eventLines renders HH:MM:SS + kind", () => {
  expect(eventLines([ev("turn.started", {})])).toEqual(["12:05:11 turn.started"]);
});

test("eventLines summarizes tool.used and input.required", () => {
  expect(eventLines([ev("tool.used", { tool: "Edit", detail: "a.ts" })])).toEqual(["12:05:11 tool.used Edit a.ts"]);
  expect(eventLines([ev("input.required", { kind: "permission" })])).toEqual(["12:05:11 input.required permission"]);
});

test("eventLines tolerates null/odd payloads", () => {
  expect(eventLines([ev("session.heartbeat", null)])).toEqual(["12:05:11 session.heartbeat"]);
});
