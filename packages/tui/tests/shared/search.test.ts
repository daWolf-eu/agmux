import { test, expect } from "bun:test";
import { matchesSearch, searchRows } from "../../src/shared/search.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("empty query matches everything", () => {
  expect(matchesSearch(mkRow(), "")).toBe(true);
});
test("matches id/agent/profile/tmux/status case-insensitively", () => {
  const r = mkRow({ session_id: "agx-DEADBEEF", profile: "infra", agent_kind: "codex", tmux_session: "main", tmux_window: "w1", status: "waiting" });
  expect(matchesSearch(r, "deadbeef")).toBe(true);
  expect(matchesSearch(r, "INFRA")).toBe(true);
  expect(matchesSearch(r, "codex")).toBe(true);
  expect(matchesSearch(r, "main")).toBe(true);
  expect(matchesSearch(r, "wait")).toBe(true);
  expect(matchesSearch(r, "nope")).toBe(false);
});
test("searchRows keeps only matches", () => {
  const rows = [mkRow({ session_id: "keep", agent_kind: "claude" }), mkRow({ session_id: "drop", agent_kind: "codex" })];
  expect(searchRows(rows, "claude").map((r) => r.session_id)).toEqual(["keep"]);
});
