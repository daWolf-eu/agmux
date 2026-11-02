import { test, expect } from "bun:test";
import { detectMux, rowMux, muxLocationText, REX_ENV_KEYS } from "../src/mux.ts";

test("detectMux", () => {
  expect(detectMux({ TMUX: "/s,1,0", REX_BLOCK: "block:x" })).toBe("tmux");
  expect(detectMux({ REX_BLOCK: "block:x" })).toBe("rex");
  expect(detectMux({ REX_SESSION: "s" })).toBeNull();
  expect(detectMux({ REX_SERVER: "unix:///x" })).toBeNull();
  expect(detectMux({})).toBeNull();
});

test("rowMux treats null and missing as tmux", () => {
  expect(rowMux({ mux: null })).toBe("tmux");
  expect(rowMux({})).toBe("tmux");
  expect(rowMux({ mux: "rex" })).toBe("rex");
});

test("REX_ENV_KEYS", () => {
  expect([...REX_ENV_KEYS]).toEqual(["REX_BLOCK", "REX_SESSION", "REX_SERVER"]);
});

test("muxLocationText", () => {
  expect(muxLocationText({ mux: null, mux_label: null, tmux_session: "work", tmux_window: "@1" })).toBe("work:@1");
  expect(muxLocationText({ mux: "rex", mux_label: "bold-creek", tmux_session: "session:01a1-abcd1234", tmux_window: "window:x" })).toBe("rex:bold-creek");
  expect(muxLocationText({ mux: "rex", mux_label: null, tmux_session: "session:01a1-abcd1234", tmux_window: null })).toBe("rex:abcd1234");
  expect(muxLocationText({ mux: null, mux_label: null, tmux_session: null, tmux_window: null })).toBe("");
  expect(muxLocationText({ mux: "rex", mux_label: "a\x1b[31mb\n", tmux_session: "session:x", tmux_window: null })).toBe("rex:a [31mb ");
});
