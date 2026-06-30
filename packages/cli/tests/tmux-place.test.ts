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

test("prepends -S <socket> to the exec args when a socket is given", async () => {
  let seen: string[] = [];
  const fakeExec = async (args: string[]) => { seen = args; return "agmux\t@4\n"; };
  await resolvePaneCoords("%7", fakeExec, "/tmp/sock");
  expect(seen.slice(0, 2)).toEqual(["-S", "/tmp/sock"]);
  expect(seen).toContain("display-message");
});

test("omits -S when socket is null", async () => {
  let seen: string[] = [];
  const fakeExec = async (args: string[]) => { seen = args; return "agmux\t@4\n"; };
  await resolvePaneCoords("%7", fakeExec, null);
  expect(seen[0]).toBe("display-message");
});
