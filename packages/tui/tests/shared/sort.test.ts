import { test, expect } from "bun:test";
import { sortRows, nextSort, SORT_KEYS } from "../../src/shared/sort.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("default status sort: waiting → running → idle → closed", () => {
  const rows = [
    mkRow({ session_id: "i", status: "idle" }),
    mkRow({ session_id: "e", status: "ended" }),
    mkRow({ session_id: "w", status: "waiting" }),
    mkRow({ session_id: "r", status: "running" }),
  ];
  expect(sortRows(rows, "status").map((r) => r.session_id)).toEqual(["w", "r", "i", "e"]);
});
test("within a status, most-recent activity first", () => {
  const rows = [
    mkRow({ session_id: "old", status: "running", last_heartbeat_ts: "2026-06-20T10:00:00.000Z" }),
    mkRow({ session_id: "new", status: "running", last_heartbeat_ts: "2026-06-20T11:00:00.000Z" }),
  ];
  expect(sortRows(rows, "status").map((r) => r.session_id)).toEqual(["new", "old"]);
});
test("sort by last ignores status", () => {
  const rows = [
    mkRow({ session_id: "a", status: "ended", last_heartbeat_ts: "2026-06-20T11:00:00.000Z" }),
    mkRow({ session_id: "b", status: "waiting", last_heartbeat_ts: "2026-06-20T10:00:00.000Z" }),
  ];
  expect(sortRows(rows, "last").map((r) => r.session_id)).toEqual(["a", "b"]);
});
test("sort by id is lexicographic", () => {
  const rows = [mkRow({ session_id: "b" }), mkRow({ session_id: "a" })];
  expect(sortRows(rows, "id").map((r) => r.session_id)).toEqual(["a", "b"]);
});
test("sortRows does not mutate input", () => {
  const rows = [mkRow({ session_id: "b", status: "idle" }), mkRow({ session_id: "a", status: "waiting" })];
  const before = rows.map((r) => r.session_id);
  sortRows(rows, "status");
  expect(rows.map((r) => r.session_id)).toEqual(before);
});
test("nextSort cycles through SORT_KEYS", () => {
  expect(nextSort("status")).toBe("last");
  expect(nextSort("last")).toBe("id");
  expect(nextSort("id")).toBe("status");
  expect(SORT_KEYS).toEqual(["status", "last", "id"]);
});
