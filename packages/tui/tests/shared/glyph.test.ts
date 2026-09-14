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

// --- shape axis: read-ness ---------------------------------------------------
test("unread → solid circle", () => {
  expect(statusGlyph(mkRow({ unread: true })).glyph).toBe(UNREAD_SHAPE);
});
test("read → outlined circle", () => {
  expect(statusGlyph(mkRow({ unread: false })).glyph).toBe(READ_SHAPE);
});
test("unread absent (null/undefined) defaults to read", () => {
  expect(statusGlyph(mkRow({ unread: null })).glyph).toBe(READ_SHAPE);
  expect(statusGlyph(mkRow({ unread: undefined })).glyph).toBe(READ_SHAPE);
  expect(isUnread(mkRow({ unread: null }))).toBe(false);
});

// --- the axes are independent -------------------------------------------------
test("shape varies with read-ness while colour stays pinned to status", () => {
  for (const row of [
    mkRow({ status: "running" }), mkRow({ status: "waiting" }), mkRow({ status: "idle" }),
    mkRow({ status: "ended", exit_code: 1 }), mkRow({ status: "ended", exit_code: 0 }),
  ]) {
    const read = statusGlyph({ ...row, unread: false });
    const unread = statusGlyph({ ...row, unread: true });
    expect(read.color).toBe(unread.color);
    expect(read.glyph).toBe(READ_SHAPE);
    expect(unread.glyph).toBe(UNREAD_SHAPE);
  }
});
