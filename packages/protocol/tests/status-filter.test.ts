import { test, expect } from "bun:test";
import { expandStatusFilter } from "../src/session.ts";

test("expands group aliases", () => {
  expect(expandStatusFilter("active")).toEqual(["running", "waiting"]);
  expect(expandStatusFilter("open")).toEqual(["idle", "running", "waiting"]);
  expect(expandStatusFilter("closed")).toEqual(["ended", "lost"]);
});

test("accepts comma-separated raw statuses", () => {
  expect(expandStatusFilter("running,lost")).toEqual(["running", "lost"]);
  expect(expandStatusFilter("idle")).toEqual(["idle"]);
});

test("rejects unknown values", () => {
  expect(expandStatusFilter("foo")).toBeNull();
  expect(expandStatusFilter("running,foo")).toBeNull();
  expect(expandStatusFilter("")).toBeNull();
});
