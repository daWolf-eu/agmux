import { test, expect } from "bun:test";
import {
  ATTACH_PLACEMENTS, isAttachPlacement, REMOTE_ATTACH_MODES, isRemoteAttachMode, isAttachTag, isTmuxKeyName, isRemoteTmux, isTmuxServerId, TMUX_SERVER_ID_FMT,
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

test("isRemoteTmux validates the optional server identity", () => {
  expect(isRemoteTmux({ ...TMUX_OK, server: "123-1730000000" })).toBe(true);
  expect(isRemoteTmux({ ...TMUX_OK, server: "123" })).toBe(true);
  expect(isRemoteTmux({ ...TMUX_OK, server: null })).toBe(true);
  expect(isRemoteTmux(TMUX_OK)).toBe(true);
  expect(isRemoteTmux({ ...TMUX_OK, server: "12;rm" })).toBe(false);
  expect(isRemoteTmux({ ...TMUX_OK, server: "" })).toBe(false);
  expect(isRemoteTmux({ ...TMUX_OK, server: 5 })).toBe(false);
});

test("isTmuxServerId", () => {
  expect(isTmuxServerId("42-100")).toBe(true);
  expect(isTmuxServerId("42")).toBe(true);
  expect(isTmuxServerId("42-")).toBe(false);
  expect(isTmuxServerId("-1")).toBe(false);
  expect(isTmuxServerId("12345678901")).toBe(false);
  expect(TMUX_SERVER_ID_FMT).toBe("#{pid}-#{start_time}");
});
