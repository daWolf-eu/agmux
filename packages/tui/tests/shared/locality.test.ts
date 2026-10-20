import { test, expect } from "bun:test";
import { hostLabel, matchesLocality, nextLocality, LOCALITY_CYCLE } from "../../src/shared/locality.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("hostLabel: local is blank, remote shows the part after the first '/', stale is marked ?", () => {
  expect(hostLabel(mkRow())).toBe("");
  expect(hostLabel(mkRow({ remote: true, host: "openshell/sbx-1" }))).toBe("⇄ sbx-1");
  expect(hostLabel(mkRow({ remote: true, host: "a/b/c" }))).toBe("⇄ b/c");
  expect(hostLabel(mkRow({ remote: true, host: "plain" }))).toBe("⇄ plain");
  expect(hostLabel(mkRow({ remote: true, host: "openshell/sbx-1", sync_stale: true }))).toBe("? sbx-1");
});

test("locality cycles all → local → remote → all", () => {
  expect(LOCALITY_CYCLE).toEqual(["all", "local", "remote"]);
  expect(nextLocality("all")).toBe("local");
  expect(nextLocality("local")).toBe("remote");
  expect(nextLocality("remote")).toBe("all");
});

test("matchesLocality", () => {
  const l = mkRow(), r = mkRow({ remote: true });
  expect([l, r].map((x) => matchesLocality(x, "all"))).toEqual([true, true]);
  expect([l, r].map((x) => matchesLocality(x, "local"))).toEqual([true, false]);
  expect([l, r].map((x) => matchesLocality(x, "remote"))).toEqual([false, true]);
});
