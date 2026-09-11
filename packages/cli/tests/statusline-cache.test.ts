import { test, expect } from "bun:test";
import { cachePath, isStale } from "../src/statusline-cache.ts";

test("cachePath honours XDG_RUNTIME_DIR, else falls back to ~/.cache", () => {
  expect(cachePath({ XDG_RUNTIME_DIR: "/run/u", HOME: "/h" })).toBe("/run/u/agmux/statusline");
  expect(cachePath({ HOME: "/h" })).toBe("/h/.cache/agmux/statusline");
});

test("heartbeat staleness is judged against the configured interval", () => {
  const t0 = Date.parse("2026-09-11T10:00:00.000Z");
  expect(isStale("2026-09-11T10:00:02.000Z", t0 + 3000, 1000)).toBe(false);
  expect(isStale("2026-09-11T10:00:00.000Z", t0 + 30000, 1000)).toBe(true);
  expect(isStale(null, t0, 1000)).toBe(true);
  expect(isStale("not-a-date", t0, 1000)).toBe(true);
});
