import { test, expect } from "bun:test";
import { resolvePaneCoords } from "../src/tmux-place.ts";

test("parses session_name<TAB>window_id from tmux", async () => {
  const fakeExec = async (_args: string[]) => "agmux\t@4\n";
  expect(await resolvePaneCoords("%7", fakeExec)).toEqual({ session: "agmux", window: "@4" });
});

test("returns null on exec failure", async () => {
  const fakeExec = async () => { throw new Error("no tmux"); };
  expect(await resolvePaneCoords("%7", fakeExec)).toBeNull();
});

test("returns null on malformed output", async () => {
  const fakeExec = async () => "garbage\n";
  expect(await resolvePaneCoords("%7", fakeExec)).toBeNull();
});
