import { test, expect } from "bun:test";
import {
  ATTACH_PLACEMENTS, isAttachPlacement, REMOTE_ATTACH_MODES, isRemoteAttachMode, isAttachTag, isTmuxKeyName, isRemoteTmux,
} from "../src/attach.ts";

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

test("remote attach modes", () => {
  expect([...REMOTE_ATTACH_MODES]).toEqual(["view", "full"]);
  expect(isRemoteAttachMode("view")).toBe(true);
  expect(isRemoteAttachMode("toggle")).toBe(false);
  expect(isRemoteAttachMode(undefined)).toBe(false);
});

test("isAttachTag", () => {
  expect(isAttachTag("p12")).toBe(true);
  expect(isAttachTag("t0a1b2c3d")).toBe(true);
  expect(isAttachTag("")).toBe(false);
  expect(isAttachTag("a;b")).toBe(false);
  expect(isAttachTag("x".repeat(33))).toBe(false);
});

test("isTmuxKeyName", () => {
  expect(isTmuxKeyName("M-d")).toBe(true);
  expect(isTmuxKeyName("F12")).toBe(true);
  expect(isTmuxKeyName("M-d;kill-server")).toBe(false);
});

const TMUX_OK = { session: "work", window: "@0", pane: "%0", socket: "/tmp/tmux-998/default" };

test("isRemoteTmux accepts replicated coords", () => {
  expect(isRemoteTmux(TMUX_OK)).toBe(true);
  expect(isRemoteTmux({ ...TMUX_OK, pane: null, socket: null })).toBe(true);
  expect(isRemoteTmux(null)).toBe(false);
  expect(isRemoteTmux({ session: "work" })).toBe(false);
});

test("isRemoteTmux rejects metacharacters", () => {
  const bad = (o: object) => expect(isRemoteTmux({ ...TMUX_OK, ...o })).toBe(false);
  for (const session of ["work:1", "a.b", "x\u0007", "", "s".repeat(129)]) bad({ session });
  for (const window of ["@1 -t x", "1"]) bad({ window });
  bad({ pane: "%1;" });
  for (const socket of ["tmp/x", "/tmp/a b"]) bad({ socket });
});
