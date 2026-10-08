import { test, expect } from "bun:test";
import { statusGlyph, statusTone, isUnread, toneGlyph, SPINNER, STATUS_COLORS } from "../../src/shared/glyph.ts";
import { MOCHA } from "../../src/shared/palette.ts";
import { mkRow } from "../helpers/mk-row.ts";

// --- colour: what do I have to do -------------------------------------------
test("waiting → yellow (needs you; red stays for errors)", () => {
  expect(statusGlyph(mkRow({ status: "waiting" })).color).toBe(MOCHA.yellow);
});
test("done (finished, unseen) → green", () => {
  expect(statusGlyph(mkRow({ status: "done" })).color).toBe(MOCHA.green);
});
test("running → neutral lavender, not green", () => {
  expect(statusGlyph(mkRow({ status: "running" })).color).toBe(MOCHA.lavender);
});
test("idle → faint text; closed → fainter still", () => {
  expect(statusGlyph(mkRow({ status: "idle" })).color).toBe(MOCHA.overlay2);
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 0 })).color).toBe(MOCHA.surface2);
  expect(statusGlyph(mkRow({ status: "lost" })).color).toBe(MOCHA.surface2);
});
test("ended non-zero or on a signal → red", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 1 })).color).toBe(MOCHA.red);
  expect(statusGlyph(mkRow({ status: "ended", exit_code: null, signal: "SIGTERM" })).color).toBe(MOCHA.red);
});
test("lost → closed, not error", () => {
  expect(statusTone(mkRow({ status: "lost" }))).toBe("closed");
});
test("every tone has a distinct colour", () => {
  expect(new Set(Object.values(STATUS_COLORS)).size).toBe(Object.keys(STATUS_COLORS).length);
});

// --- shape: repeats the state --------------------------------------------------
test("glyph shapes: ? waiting, ● done, ○ idle, · closed/lost/error", () => {
  expect(statusGlyph(mkRow({ status: "waiting" })).glyph).toBe("?");
  expect(statusGlyph(mkRow({ status: "done" })).glyph).toBe("●");
  expect(statusGlyph(mkRow({ status: "idle" })).glyph).toBe("○");
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 0 })).glyph).toBe("·");
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 2 })).glyph).toBe("·");
  expect(statusGlyph(mkRow({ status: "lost" })).glyph).toBe("·");
});
test("running is a braille spinner advanced by frame (wrapping)", () => {
  const r = mkRow({ status: "running" });
  expect(statusGlyph(r).glyph).toBe("⠋");
  expect(statusGlyph(r, 3).glyph).toBe("⠸");
  expect(statusGlyph(r, SPINNER.length).glyph).toBe("⠋");
  expect(toneGlyph("running", 9)).toBe("⠏");
});
test("only done is unread", () => {
  expect(isUnread(mkRow({ status: "done" }))).toBe(true);
  for (const status of ["idle", "running", "waiting", "ended", "lost"] as const) {
    expect(isUnread(mkRow({ status }))).toBe(false);
  }
});
