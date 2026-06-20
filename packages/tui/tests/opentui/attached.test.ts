import { test, expect } from "bun:test";
import { matchAttachedPane } from "../../src/opentui/attached.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("matches the row whose tmux_pane equals the active pane", () => {
  const rows = [mkRow({ session_id: "a", tmux_pane: "%3" }), mkRow({ session_id: "b", tmux_pane: "%5" })];
  expect(matchAttachedPane(rows, "%5")).toBe("b");
});
test("no active pane → null", () => {
  expect(matchAttachedPane([mkRow({ tmux_pane: "%3" })], null)).toBeNull();
});
test("no matching pane → null", () => {
  expect(matchAttachedPane([mkRow({ tmux_pane: "%3" })], "%9")).toBeNull();
});
