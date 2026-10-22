import { test, expect, afterEach } from "bun:test";
import { DEFAULT_REMOTE_MARK } from "@agmux/protocol";
import { remoteMark, setRemoteMark } from "@agmux/tui";
import { applyUiConfig } from "../src/ui-config.ts";

afterEach(() => setRemoteMark(DEFAULT_REMOTE_MARK));

test("[ui] remote_mark replaces the remote mark", () => {
  expect(applyUiConfig("x", () => ({ remoteMark: "" }))).toBeNull();
  expect(remoteMark()).toBe("");
});

test("an invalid [ui] keeps the default and reports it", () => {
  const msg = applyUiConfig("x", () => { throw new Error("[ui] remote_mark must be a 1-2 cell mark, got \"\""); });
  expect(msg).toContain("[ui] remote_mark");
  expect(remoteMark()).toBe(DEFAULT_REMOTE_MARK);
});

test("other config errors are left to the verb (no [ui] warning)", () => {
  expect(applyUiConfig("x", () => { throw new Error("Invalid TOML document"); })).toBeNull();
  expect(remoteMark()).toBe(DEFAULT_REMOTE_MARK);
});
