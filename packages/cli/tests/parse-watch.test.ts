import { test, expect } from "bun:test";
import { parseWatchArgs } from "../src/parse-watch.ts";

test("defaults: status open, sort started desc, 1s interval", () => {
  const p = parseWatchArgs([]);
  if (p.kind !== "ok") throw new Error(p.message);
  expect(p.opts.status).toBe("open");
  expect(p.opts.sort).toBe("started");
  expect(p.opts.asc).toBe(false);
  expect(p.opts.intervalMs).toBe(1000);
});

test("ls flags pass through and override watch defaults", () => {
  const p = parseWatchArgs(["--status", "active", "--sort", "activity", "-n", "10", "-r"]);
  if (p.kind !== "ok") throw new Error(p.message);
  expect(p.opts.status).toBe("active");
  expect(p.opts.sort).toBe("activity");
  expect(p.opts.limit).toBe(10);
  expect(p.opts.reverse).toBe(true);
});

test("--interval accepts seconds in both flag forms, including fractions", () => {
  const a = parseWatchArgs(["--interval", "5"]);
  if (a.kind !== "ok") throw new Error(a.message);
  expect(a.opts.intervalMs).toBe(5000);
  const b = parseWatchArgs(["-i=0.5"]);
  if (b.kind !== "ok") throw new Error(b.message);
  expect(b.opts.intervalMs).toBe(500);
});

test("invalid interval errors", () => {
  expect(parseWatchArgs(["--interval", "0"]).kind).toBe("error");
  expect(parseWatchArgs(["--interval", "abc"]).kind).toBe("error");
  expect(parseWatchArgs(["--interval"]).kind).toBe("error");
});

test("unknown flag errors with a watch-prefixed message", () => {
  const p = parseWatchArgs(["--bogus"]);
  expect(p.kind).toBe("error");
  if (p.kind === "error") expect(p.message).toStartWith("watch:");
});
