import { test, expect } from "bun:test";
import { computeEffectiveStatus } from "../src/lost.ts";
import { LOST_THRESHOLD_MS } from "@agmux/protocol";

const baseRow = {
  status: "idle" as const,
  start_ts: "2026-05-28T12:00:00.000Z",
  last_heartbeat_ts: "2026-05-28T12:00:00.000Z",
  end_ts: null as string | null,
};

test("recent heartbeat → status unchanged", () => {
  const now = new Date("2026-05-28T12:00:30.000Z");
  expect(computeEffectiveStatus(baseRow, now)).toBe("idle");
});

test("stale heartbeat (>60s) on a live row → 'lost'", () => {
  const now = new Date("2026-05-28T12:02:00.000Z");
  expect(computeEffectiveStatus(baseRow, now)).toBe("lost");
});

test("status='ended' stays 'ended' regardless of heartbeat age", () => {
  const now = new Date("2026-05-28T20:00:00.000Z");
  const row = { ...baseRow, status: "ended" as const, end_ts: "2026-05-28T12:05:00.000Z" };
  expect(computeEffectiveStatus(row, now)).toBe("ended");
});

test("never-heartbeated row falls back to start_ts for staleness check", () => {
  const now = new Date("2026-05-28T12:02:00.000Z");
  const row = { ...baseRow, last_heartbeat_ts: null };
  expect(computeEffectiveStatus(row, now)).toBe("lost");
});

test("threshold constant matches protocol", () => {
  expect(LOST_THRESHOLD_MS).toBe(60_000);
});
