import { test, expect } from "bun:test";
import { matchesFilter, filterRows } from "../../src/shared/filter.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("empty query matches everything", () => {
  expect(matchesFilter(mkRow(), "")).toBe(true);
});
test("matches id/agent/profile/tmux/status case-insensitively", () => {
  const r = mkRow({ session_id: "agx-DEADBEEF", profile: "infra", agent_kind: "codex", tmux_session: "main", tmux_window: "w1", status: "waiting" });
  expect(matchesFilter(r, "deadbeef")).toBe(true);
  expect(matchesFilter(r, "INFRA")).toBe(true);
  expect(matchesFilter(r, "codex")).toBe(true);
  expect(matchesFilter(r, "main")).toBe(true);
  expect(matchesFilter(r, "wait")).toBe(true);
  expect(matchesFilter(r, "nope")).toBe(false);
});
test("filterRows keeps only matches", () => {
  const rows = [mkRow({ session_id: "keep", agent_kind: "claude" }), mkRow({ session_id: "drop", agent_kind: "codex" })];
  expect(filterRows(rows, "claude").map((r) => r.session_id)).toEqual(["keep"]);
});
