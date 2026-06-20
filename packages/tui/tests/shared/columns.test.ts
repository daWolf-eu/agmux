import { test, expect } from "bun:test";
import { rowCells, COLS, columnWidths, pad, ID_MAX, TMUX_MAX } from "../../src/shared/columns.ts";
import { mkRow } from "../helpers/mk-row.ts";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

test("ID truncates to 13 chars with NO ellipsis", () => {
  const c = rowCells(mkRow({ session_id: "agx-9d2c1a0f4abcdef" }), NOW);
  expect(c.id).toBe("agx-9d2c1a0f4");
  expect(c.id.length).toBe(ID_MAX);
  expect(c.id.endsWith("…")).toBe(false);
});
test("TMUX joins session:window, truncates at 32 WITH ellipsis", () => {
  const short = rowCells(mkRow({ tmux_session: "main", tmux_window: "agmux.1" }), NOW);
  expect(short.tmux).toBe("main:agmux.1");
  const long = rowCells(mkRow({ tmux_session: "spike", tmux_window: "pty-experiment-longwindowname" }), NOW);
  expect(long.tmux.length).toBe(TMUX_MAX);
  expect(long.tmux.endsWith("…")).toBe(true);
});
test("TMUX em-dash when missing", () => {
  expect(rowCells(mkRow({ tmux_session: null, tmux_window: null }), NOW).tmux).toBe("—");
});
test("turns: null → dash, number → string", () => {
  expect(rowCells(mkRow({ turn_count: null }), NOW).turns).toBe("-");
  expect(rowCells(mkRow({ turn_count: 0 }), NOW).turns).toBe("0");
  expect(rowCells(mkRow({ turn_count: 14 }), NOW).turns).toBe("14");
});
test("last uses last_heartbeat_ts, falls back to start_ts", () => {
  expect(rowCells(mkRow({ last_heartbeat_ts: "2026-06-20T11:59:57.000Z" }), NOW).last).toBe("3s");
  expect(rowCells(mkRow({ last_heartbeat_ts: null, start_ts: "2026-06-20T11:50:00.000Z" }), NOW).last).toBe("10m");
});
test("columnWidths is max(header, widest cell) per column", () => {
  const cells = [rowCells(mkRow({ agent_kind: "claude" }), NOW), rowCells(mkRow({ agent_kind: "codex" }), NOW)];
  const w = columnWidths(cells);
  expect(w.agent).toBe(6); // "claude"(6) > "AGENT"(5)
});
test("pad left vs right", () => {
  expect(pad("7", 4, "right")).toBe("   7");
  expect(pad("ab", 4, "left")).toBe("ab  ");
});
test("COLS order is id,tmux,agent,profile,turns,last", () => {
  expect(COLS.map((c) => c.key)).toEqual(["id", "tmux", "agent", "profile", "turns", "last"]);
});
