import { test, expect } from "bun:test";
import { statusGlyph } from "../../src/shared/glyph.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("waiting → amber fisheye", () => {
  expect(statusGlyph(mkRow({ status: "waiting" }))).toEqual({ glyph: "◉", color: "#f9e2af" });
});
test("running → green dot", () => {
  expect(statusGlyph(mkRow({ status: "running" }))).toEqual({ glyph: "●", color: "#a6e3a1" });
});
test("idle → grey ring", () => {
  expect(statusGlyph(mkRow({ status: "idle" }))).toEqual({ glyph: "○", color: "#6c7086" });
});
test("ended clean → muted dot (closed)", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 0 }))).toEqual({ glyph: "·", color: "#585b70" });
});
test("ended non-zero → red error", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 1 }))).toEqual({ glyph: "✕", color: "#f38ba8" });
});
test("ended on signal → red error", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: null, signal: "SIGTERM" }))).toEqual({ glyph: "✕", color: "#f38ba8" });
});
test("lost → muted dot (closed, not error)", () => {
  expect(statusGlyph(mkRow({ status: "lost" }))).toEqual({ glyph: "·", color: "#585b70" });
});
