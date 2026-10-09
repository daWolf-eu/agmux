import { test, expect } from "bun:test";
import { ATTACH_PLACEMENTS, isAttachPlacement } from "../src/attach.ts";

test("placements are the popup's fixed slot order", () => {
  expect([...ATTACH_PLACEMENTS]).toEqual([
    "inline", "new-pane", "new-window", "new-session", "peek", "new-tab", "new-terminal",
  ]);
});

test("isAttachPlacement accepts only known names", () => {
  expect(isAttachPlacement("new-window")).toBe(true);
  expect(isAttachPlacement("window")).toBe(false);
  expect(isAttachPlacement(undefined)).toBe(false);
  expect(isAttachPlacement(3)).toBe(false);
});
