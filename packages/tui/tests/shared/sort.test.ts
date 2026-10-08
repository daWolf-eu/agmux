import { test, expect } from "bun:test";
import { sortRows, nextSort, sortDirection, DEFAULT_SORT } from "../../src/shared/sort.ts";
import { mkRow } from "../helpers/mk-row.ts";

const at = (h: number) => `2026-06-20T${String(h).padStart(2, "0")}:00:00.000Z`;

test("default is the status (glyph) sort", () => {
  expect(DEFAULT_SORT).toBe("glyph");
});
test("status sort: waiting → done → running → idle/closed", () => {
  const rows = [
    mkRow({ session_id: "i", status: "idle", last_heartbeat_ts: at(9) }),
    mkRow({ session_id: "e", status: "ended", last_heartbeat_ts: at(8) }),
    mkRow({ session_id: "r", status: "running" }),
    mkRow({ session_id: "d", status: "done" }),
    mkRow({ session_id: "w", status: "waiting" }),
  ];
  expect(sortRows(rows, "glyph").map((r) => r.session_id)).toEqual(["w", "d", "r", "i", "e"]);
});
test("idle and closed share a rank and interleave by recency", () => {
  const rows = [
    mkRow({ session_id: "i-old", status: "idle", last_heartbeat_ts: at(8) }),
    mkRow({ session_id: "lost-new", status: "lost", last_heartbeat_ts: at(10) }),
  ];
  expect(sortRows(rows, "glyph").map((r) => r.session_id)).toEqual(["lost-new", "i-old"]);
});
test("last_seen (newest first) breaks every tie", () => {
  const rows = [
    mkRow({ session_id: "old", status: "running", git_repo: "x", last_heartbeat_ts: at(10) }),
    mkRow({ session_id: "new", status: "running", git_repo: "x", last_heartbeat_ts: at(11) }),
  ];
  expect(sortRows(rows, "glyph").map((r) => r.session_id)).toEqual(["new", "old"]);
  expect(sortRows(rows, "repo").map((r) => r.session_id)).toEqual(["new", "old"]);
});
test("sort by last_seen ignores status", () => {
  const rows = [
    mkRow({ session_id: "a", status: "ended", last_heartbeat_ts: at(11) }),
    mkRow({ session_id: "b", status: "waiting", last_heartbeat_ts: at(10) }),
  ];
  expect(sortRows(rows, "last_seen").map((r) => r.session_id)).toEqual(["a", "b"]);
});
test("text columns sort a→z with blanks last", () => {
  const rows = [
    mkRow({ session_id: "none", git_repo: null }),
    mkRow({ session_id: "b", git_repo: "beta" }),
    mkRow({ session_id: "a", git_repo: "alpha" }),
  ];
  expect(sortRows(rows, "repo").map((r) => r.session_id)).toEqual(["a", "b", "none"]);
  expect(sortDirection("repo")).toBe("asc");
  expect(sortDirection("glyph")).toBe("desc");
});
test("sortRows does not mutate input", () => {
  const rows = [mkRow({ session_id: "b", status: "idle" }), mkRow({ session_id: "a", status: "waiting" })];
  const before = rows.map((r) => r.session_id);
  sortRows(rows, "glyph");
  expect(rows.map((r) => r.session_id)).toEqual(before);
});
test("nextSort cycles through the visible columns in order", () => {
  const cols = ["glyph", "name", "last_seen"] as const;
  expect(nextSort("glyph", [...cols])).toBe("name");
  expect(nextSort("name", [...cols])).toBe("last_seen");
  expect(nextSort("last_seen", [...cols])).toBe("glyph");
  // a key that isn't visible restarts at the first column
  expect(nextSort("glyph", ["name", "repo"])).toBe("name");
});
