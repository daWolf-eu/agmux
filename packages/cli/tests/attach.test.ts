import { test, expect } from "bun:test";
import { buildAttachCommands } from "../src/attach.ts";

const coords = { tmux_session: "agmux", tmux_window: "@4", tmux_pane: "%3" };

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
