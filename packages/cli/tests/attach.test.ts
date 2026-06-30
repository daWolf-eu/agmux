import { test, expect } from "bun:test";
import { buildAttachCommands } from "../src/attach.ts";

const coords = { tmux_session: "agmux", tmux_window: "@4", tmux_pane: "%3", tmux_socket: null };

test("inTmux: switches window then selects the session's own pane", () => {
  expect(buildAttachCommands(coords, true)).toEqual([
    ["switch-client", "-t", "agmux:@4"],
    ["select-pane", "-t", "%3"],
  ]);
});

test("inTmux: window-only fallback when no pane stored", () => {
  expect(buildAttachCommands({ ...coords, tmux_pane: null }, true)).toEqual([
    ["switch-client", "-t", "agmux:@4"],
  ]);
});

test("not inTmux: one chained attach that selects window and pane", () => {
  expect(buildAttachCommands(coords, false)).toEqual([
    ["attach-session", "-t", "agmux", ";", "select-window", "-t", "agmux:@4", ";", "select-pane", "-t", "%3"],
  ]);
});

test("not inTmux: window-only fallback when no pane stored", () => {
  expect(buildAttachCommands({ ...coords, tmux_pane: null }, false)).toEqual([
    ["attach-session", "-t", "agmux", ";", "select-window", "-t", "agmux:@4"],
  ]);
});

test("inTmux: prefixes -S socket on each command when tmux_socket set", () => {
  expect(buildAttachCommands({ ...coords, tmux_socket: "/sock" }, true)).toEqual([
    ["-S", "/sock", "switch-client", "-t", "agmux:@4"],
    ["-S", "/sock", "select-pane", "-t", "%3"],
  ]);
});

test("not inTmux: prefixes -S socket on the chained attach when tmux_socket set", () => {
  expect(buildAttachCommands({ ...coords, tmux_socket: "/sock" }, false)).toEqual([
    ["-S", "/sock", "attach-session", "-t", "agmux", ";", "select-window", "-t", "agmux:@4", ";", "select-pane", "-t", "%3"],
  ]);
});

test("omits -S when tmux_socket is null", () => {
  expect(buildAttachCommands(coords, true)[0]!.slice(0, 2)).toEqual(["switch-client", "-t"]);
});
