import { test, expect } from "bun:test";
import {
  rowCells, columnWidths, fitWidths, rowWidth, gapAfter, abbreviateBranch, pad, clip, fitCell, isColumnKey,
  COLUMNS, COLUMN_KEYS, DEFAULT_COLUMNS, type ColumnKey,
} from "../../src/shared/columns.ts";
import { mkRow } from "../helpers/mk-row.ts";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

test("default columns are glyph,name,repo,branch,last_seen", () => {
  expect(DEFAULT_COLUMNS).toEqual(["glyph", "name", "repo", "branch", "last_seen"]);
  for (const k of COLUMN_KEYS) expect(COLUMNS[k].key).toBe(k);
  expect(isColumnKey("branch")).toBe(true);
  expect(isColumnKey("nope")).toBe(false);
});
test("name falls back to the short session id", () => {
  expect(rowCells(mkRow({ name: "fix-e2e" }), ["name"], NOW).name).toBe("fix-e2e");
  expect(rowCells(mkRow({ session_id: "agx-9d2c1a0f4abcdef", name: null }), ["name"], NOW).name).toBe("agx-9d2c1a0f4");
});
test("repo/branch come from git metadata, blank when missing", () => {
  const c = rowCells(mkRow({ git_repo: "agmux", git_branch: "main" }), ["repo", "branch"], NOW);
  expect(c).toEqual({ repo: "agmux", branch: "main" });
  expect(rowCells(mkRow(), ["repo", "branch"], NOW)).toEqual({ repo: "", branch: "" });
});
test("only requested columns are computed", () => {
  expect(Object.keys(rowCells(mkRow(), ["name", "last_seen"], NOW))).toEqual(["name", "last_seen"]);
});
test("ID is a hard 13-char cut, no ellipsis", () => {
  expect(rowCells(mkRow({ session_id: "agx-9d2c1a0f4abcdef" }), ["id"], NOW).id).toBe("agx-9d2c1a0f4");
});
test("capped columns clip with an ellipsis", () => {
  const long = rowCells(mkRow({ tmux_session: "spike", tmux_window: "pty-experiment-longwindowname" }), ["tmux"], NOW).tmux!;
  expect(long.length).toBe(32);
  expect(long.endsWith("…")).toBe(true);
});
test("last_seen uses last_heartbeat_ts, falls back to start_ts", () => {
  expect(rowCells(mkRow({ last_heartbeat_ts: "2026-06-20T11:59:57.000Z" }), ["last_seen"], NOW).last_seen).toBe("3s");
  expect(rowCells(mkRow({ last_heartbeat_ts: null, start_ts: "2026-06-20T11:50:00.000Z" }), ["last_seen"], NOW).last_seen).toBe("10m");
});
test("widths count the header only when it is shown; glyph is always 1", () => {
  const cols: ColumnKey[] = ["glyph", "agent"];
  const cells = [rowCells(mkRow({ agent_kind: "pi" }), cols, NOW)];
  expect(columnWidths(cols, cells, false)).toEqual({ glyph: 1, agent: 2 });
  expect(columnWidths(cols, cells, true)).toEqual({ glyph: 1, agent: 5 });
});
test("fitWidths shrinks branch, then repo, then name — each to its floor", () => {
  const cols: ColumnKey[] = ["glyph", "name", "repo", "branch", "last_seen"];
  const w = { glyph: 1, name: 30, repo: 20, branch: 20, last_seen: 3 };
  const total = rowWidth(cols, w);
  // 1 space after the glyph, 5 between every other pair
  expect(total).toBe(1 + 30 + 20 + 20 + 3 + 1 + 5 * 3);
  const a = fitWidths(cols, w, total - 10);
  expect(a).toMatchObject({ name: 30, repo: 18, branch: 12 });
  const b = fitWidths(cols, w, total - 30);
  expect(b).toMatchObject({ name: 22, repo: 6, branch: 12 });
  const c = fitWidths(cols, w, 10);
  expect(c).toMatchObject({ name: 12, repo: 6, branch: 12, glyph: 1, last_seen: 3 });
});
test("clip / pad / fitCell", () => {
  expect(clip("abcdef", 4)).toBe("abc…");
  expect(clip("ab", 4)).toBe("ab");
  expect(pad("7", 4, "right")).toBe("   7");
  expect(pad("ab", 4, "left")).toBe("ab  ");
  expect(fitCell("abcdef", 4, "left")).toBe("abc…");
});

test("gapAfter: 1 space after the glyph, 5 elsewhere, none after the last", () => {
  const cols: ColumnKey[] = ["glyph", "name", "repo"];
  expect(cols.map((_, i) => gapAfter(cols, i))).toEqual([" ", "     ", ""]);
  expect(gapAfter(["name", "glyph"], 0)).toBe("     ");
});

test("abbreviateBranch collapses a known prefix to its initial, then clips the name", () => {
  expect(abbreviateBranch("feature/short", 20)).toBe("feature/short"); // fits → untouched
  expect(abbreviateBranch("feature/improve-look-and-feel", 12)).toBe("f…/improve-…");
  expect(abbreviateBranch("feature/improve-look", 16)).toBe("f…/improve-look"); // prefix alone makes it fit
  for (const [p, i] of [["feat", "f"], ["bugfix", "b"], ["bug", "b"], ["chore", "c"], ["hotfix", "h"]] as const)
    expect(abbreviateBranch(`${p}/abcdefghijklmnop`, 12)).toBe(`${i}…/abcdefgh…`);
  expect(abbreviateBranch("release/abcdefghijklmnop", 12)).toBe("release/abc…"); // unknown prefix → plain clip
  expect(abbreviateBranch("featureless-branch-name", 12)).toBe("featureless…");
});
test("the branch cap uses the same abbreviation", () => {
  const c = rowCells(mkRow({ git_branch: "feature/" + "x".repeat(40) }), ["branch"], NOW);
  expect(c.branch).toBe("f…/" + "x".repeat(28) + "…");
});

test("branch is the accent column; other optional columns stay secondary text", () => {
  expect(COLUMNS.branch.style).toBe("accent");
  expect(COLUMNS.repo.style).toBe("faint");
  for (const k of ["id", "agent", "profile", "tmux", "turns", "activity", "project"] as const) expect(COLUMNS[k].style).toBe("sub");
});
