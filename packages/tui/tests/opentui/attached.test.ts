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
test("socket-aware: same pane on different servers disambiguated by socket", () => {
  // %3 is reused across two tmux servers; only socket distinguishes them.
  const rows = [
    mkRow({ session_id: "default", tmux_pane: "%3", tmux_socket: null }),
    mkRow({ session_id: "demo1", tmux_pane: "%3", tmux_socket: "/tmp/demo1" }),
  ];
  expect(matchAttachedPane(rows, "%3", "/tmp/demo1")).toBe("demo1");
  expect(matchAttachedPane(rows, "%3", null)).toBe("default");
});
