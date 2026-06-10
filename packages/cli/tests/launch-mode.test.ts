import { test, expect } from "bun:test";
import { decideLaunchMode } from "../src/launch-mode.ts";

test("adapter present, not --wrapped → direct", () => {
  expect(decideLaunchMode({ wrapped: false, hasAdapter: true })).toBe("direct");
});

test("--wrapped forces wrapped even with adapter", () => {
  expect(decideLaunchMode({ wrapped: true, hasAdapter: true })).toBe("wrapped");
});

test("no adapter auto-wraps", () => {
  expect(decideLaunchMode({ wrapped: false, hasAdapter: false })).toBe("wrapped");
});

test("no adapter + --wrapped → wrapped", () => {
  expect(decideLaunchMode({ wrapped: true, hasAdapter: false })).toBe("wrapped");
});
