import { test, expect } from "bun:test";
import { statusGlyph, statusTone, isUnread, READ_SHAPE, UNREAD_SHAPE } from "../../src/shared/glyph.ts";
import { mkRow } from "../helpers/mk-row.ts";

// --- colour axis: status ------------------------------------------------------
// Colour alone carries status, so every tone is asserted independently of shape.
test("running → green", () => {
  expect(statusGlyph(mkRow({ status: "running" })).color).toBe("#a6e3a1");
});
test("waiting → amber", () => {
  expect(statusGlyph(mkRow({ status: "waiting" })).color).toBe("#f9e2af");
});
test("idle → grey", () => {
  expect(statusGlyph(mkRow({ status: "idle" })).color).toBe("#6c7086");
});
test("ended clean → muted (closed)", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 0 })).color).toBe("#45475a");
});
test("ended non-zero → red", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 1 })).color).toBe("#f38ba8");
});
test("ended on signal → red", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: null, signal: "SIGTERM" })).color).toBe("#f38ba8");
});
test("lost → muted (closed, not error)", () => {
  expect(statusTone(mkRow({ status: "lost" }))).toBe("closed");
});
test("closed is dimmer than idle, the two now differing only by colour", () => {
  const idle = statusGlyph(mkRow({ status: "idle" }));
  const closed = statusGlyph(mkRow({ status: "ended", exit_code: 0 }));
  expect(idle.glyph).toBe(closed.glyph);
  expect(idle.color).not.toBe(closed.color);
});

// --- shape axis: seen-ness ---------------------------------------------------
test("done (finished, unseen) → solid circle", () => {
  expect(statusGlyph(mkRow({ status: "done" })).glyph).toBe(UNREAD_SHAPE);
  expect(isUnread(mkRow({ status: "done" }))).toBe(true);
});
test("every other status → outlined circle", () => {
  for (const status of ["idle", "running", "waiting", "ended", "lost"] as const) {
    expect(statusGlyph(mkRow({ status })).glyph).toBe(READ_SHAPE);
    expect(isUnread(mkRow({ status }))).toBe(false);
  }
});
test("done keeps the idle colour (palette rework is separate)", () => {
  expect(statusGlyph(mkRow({ status: "done" })).color).toBe(statusGlyph(mkRow({ status: "idle" })).color);
});
