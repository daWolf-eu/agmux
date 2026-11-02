import { test, expect } from "bun:test";
import { detectMux, rowMux, REX_ENV_KEYS } from "../src/mux.ts";

test("detectMux", () => {
  expect(detectMux({ TMUX: "/s,1,0", REX_BLOCK: "block:x" })).toBe("tmux");
  expect(detectMux({ REX_BLOCK: "block:x" })).toBe("rex");
  expect(detectMux({ REX_SESSION: "s" })).toBe("rex");
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
