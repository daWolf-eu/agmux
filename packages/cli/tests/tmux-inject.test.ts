import { test, expect } from "bun:test";
import { sanitizePayload, computeNeedle } from "../src/tmux-inject.ts";

// sanitizePayload returns the exact bytes to load into the tmux buffer.
// Compare via Array.from for readable failures.
const bytes = (s: string) => Array.from(sanitizePayload(s));

test("sanitizePayload converts \\n to CR (0x0D) and appends a trailing newline", () => {
  // "a\nb" → 'a', CR, 'b', and a trailing CR from the appended "\n"
  expect(bytes("a\nb")).toEqual([0x61, 0x0d, 0x62, 0x0d]);
});

test("sanitizePayload normalizes CRLF and CR to a single newline", () => {
  expect(bytes("a\r\nb")).toEqual([0x61, 0x0d, 0x62, 0x0d]);
  expect(bytes("a\rb")).toEqual([0x61, 0x0d, 0x62, 0x0d]);
});

test("sanitizePayload keeps tab but drops other control bytes (e.g. ESC)", () => {
  // "\t" kept as 0x09; ESC (0x1b) dropped so it can't close the bracketed paste
  expect(bytes("a\tb")).toEqual([0x61, 0x09, 0x62, 0x0d]);
  expect(bytes("a\x1bb")).toEqual([0x61, 0x62, 0x0d]);
});

test("sanitizePayload encodes multibyte UTF-8 printables", () => {
  // "é" is 0xC3 0xA9 in UTF-8, then the appended trailing CR
  expect(bytes("é")).toEqual([0xc3, 0xa9, 0x0d]);
});

test("sanitizePayload trailing backslash is absorbed by the appended newline", () => {
  // "x\\" → 'x', '\\', CR — the CR means the submit Enter is a fresh keypress,
  // not a line-continuation of the backslash.
  expect(bytes("x\\")).toEqual([0x78, 0x5c, 0x0d]);
});

test("computeNeedle takes the first non-empty line, stripped, truncated at first control char, max 24 chars", () => {
  expect(computeNeedle("  hello world  ")).toBe("hello world");
  expect(computeNeedle("\n\n  second line is used")).toBe("second line is used");
  expect(computeNeedle("before\tafter")).toBe("before"); // truncates at the tab
  expect(computeNeedle("x".repeat(40))).toBe("x".repeat(24));
  expect(computeNeedle("   \n   ")).toBe(""); // all whitespace → empty needle
});
