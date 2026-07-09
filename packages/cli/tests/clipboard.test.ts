import { test, expect } from "bun:test";
import {
  copyToClipboard, clipboardCandidates, osc52, type ClipboardDeps,
} from "../src/clipboard.ts";

function mkDeps(over: Partial<ClipboardDeps> = {}): ClipboardDeps & {
  spawned: { argv: string[]; input: string }[]; written: string[];
} {
  const spawned: { argv: string[]; input: string }[] = [];
  const written: string[] = [];
  return {
    platform: "darwin",
    env: {},
    which: () => true,
    spawn: async (argv, input) => { spawned.push({ argv, input }); return true; },
    writeOut: (d) => { written.push(d); },
    spawned, written, ...over,
  };
}

test("darwin prefers pbcopy", () => {
  expect(clipboardCandidates("darwin", () => true)).toEqual([["pbcopy"]]);
});

test("linux tries wl-copy, xclip, xsel in order when all present", () => {
  expect(clipboardCandidates("linux", () => true)).toEqual([
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ]);
});

test("linux skips tools not on PATH", () => {
  const which = (c: string) => c === "xclip";
  expect(clipboardCandidates("linux", which)).toEqual([["xclip", "-selection", "clipboard"]]);
});

test("unknown platform has no native candidates", () => {
  expect(clipboardCandidates("freebsd", () => true)).toEqual([]);
});

test("copyToClipboard spawns the first native tool with the text as stdin", async () => {
  const deps = mkDeps();
  await copyToClipboard("hello", deps);
  expect(deps.spawned).toEqual([{ argv: ["pbcopy"], input: "hello" }]);
  expect(deps.written).toEqual([]);
});

test("falls back to OSC 52 when there is no native tool", async () => {
  const deps = mkDeps({ platform: "freebsd" });
  await copyToClipboard("hi", deps);
  expect(deps.spawned).toEqual([]);
  expect(deps.written).toEqual([osc52("hi", false)]);
});

test("falls back to OSC 52 when the native spawn fails", async () => {
  const deps = mkDeps({ spawn: async () => false });
  await copyToClipboard("hi", deps);
  expect(deps.written).toEqual([osc52("hi", false)]);
});

test("osc52 encodes base64 and terminates with BEL", () => {
  const b64 = Buffer.from("hi", "utf8").toString("base64");
  expect(osc52("hi", false)).toBe(`\x1b]52;c;${b64}\x07`);
});

test("osc52 wraps in tmux passthrough (inner ESC doubled) when tmux=true", () => {
  const b64 = Buffer.from("hi", "utf8").toString("base64");
  const inner = `\x1b]52;c;${b64}\x07`;
  const doubled = inner.replace(/\x1b/g, "\x1b\x1b");
  expect(osc52("hi", true)).toBe(`\x1bPtmux;\x1b${doubled}\x1b\\`);
});

test("copyToClipboard uses tmux-wrapped OSC 52 when $TMUX is set and no native tool", async () => {
  const deps = mkDeps({ platform: "freebsd", env: { TMUX: "/tmp/tmux-501/default,123,0" } });
  await copyToClipboard("hi", deps);
  expect(deps.written).toEqual([osc52("hi", true)]);
});
