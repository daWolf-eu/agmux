import { test, expect } from "bun:test";
import { resolvePrefix } from "../src/id-resolve.ts";

const ids = [
  "0190a3e0-1111-7000-8000-000000000000",
  "0190a3e0-2222-7000-8000-000000000000",
  "0190b4f1-3333-7000-8000-000000000000",
];

test("exact match", () => {
  expect(resolvePrefix("0190a3e0-1111-7000-8000-000000000000", ids))
    .toEqual({ ok: true, id: ids[0]! });
});

test("unique prefix", () => {
  expect(resolvePrefix("0190b4f1", ids)).toEqual({ ok: true, id: ids[2]! });
});

test("ambiguous prefix", () => {
  const r = resolvePrefix("0190a3e0", ids);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/ambiguous/);
});

test("no match", () => {
  const r = resolvePrefix("dead", ids);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/no session/);
});
