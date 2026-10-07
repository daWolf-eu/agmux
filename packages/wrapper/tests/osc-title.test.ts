import { test, expect } from "bun:test";
import { OscTitleParser } from "../src/osc-title.ts";

test("extracts OSC 0 and OSC 2 titles with BEL or ST terminators", () => {
  const p = new OscTitleParser();
  expect(p.feed("hi\x1b]0;⠂ task\x07there\x1b]2;✳ task\x1b\\")).toEqual(["⠂ task", "✳ task"]);
});

test("ignores other OSCs and plain escapes", () => {
  const p = new OscTitleParser();
  expect(p.feed("\x1b[31mred\x1b[0m\x1b]8;;http://x\x07link\x1b]8;;\x07")).toEqual([]);
});

test("survives a sequence split at every byte, including inside UTF-8", () => {
  const p = new OscTitleParser();
  const bytes = Buffer.from("x\x1b]0;✳ naïve\x07y", "utf8");
  const out: string[] = [];
  for (const b of bytes) out.push(...p.feed(Buffer.from([b])));
  expect(out).toEqual(["✳ naïve"]);
});

test("an oversized OSC is skipped without buffering, and parsing recovers", () => {
  const p = new OscTitleParser();
  expect(p.feed(`\x1b]0;${"a".repeat(10_000)}\x07`)).toEqual([]);
  expect(p.feed("\x1b]0;ok\x07")).toEqual(["ok"]);
});
