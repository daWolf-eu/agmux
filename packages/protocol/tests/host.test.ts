import { describe, expect, test } from "bun:test";
import { resolveHost, isValidHostName } from "../src/host.ts";

describe("resolveHost", () => {
  test("AGMUX_HOST overrides the hostname", () => {
    expect(resolveHost({ AGMUX_HOST: "ai-sandbox/wi-sag-280" }, "144190573f15")).toBe("ai-sandbox/wi-sag-280");
  });

  test("falls back to the hostname when unset or empty", () => {
    expect(resolveHost({}, "mac.local")).toBe("mac.local");
    expect(resolveHost({ AGMUX_HOST: "" }, "mac.local")).toBe("mac.local");
  });

  test("falls back to the hostname when AGMUX_HOST is invalid", () => {
    for (const bad of ["a b", "a/b/c", "a/../b"]) {
      expect(resolveHost({ AGMUX_HOST: bad }, "mac.local")).toBe("mac.local");
    }
  });
});

describe("isValidHostName", () => {
  test("accepts name and gateway/sandbox", () => {
    expect(isValidHostName("mac.local")).toBe(true);
    expect(isValidHostName("gw/sb-1")).toBe(true);
  });
  test("rejects over-long names", () => {
    expect(isValidHostName("a".repeat(256))).toBe(false);
  });
});

import { sanitizeRemoteText } from "../src/host.ts";
describe("sanitizeRemoteText", () => {
  test("replaces control chars and collapses whitespace", () => {
    expect(sanitizeRemoteText("\x1b[31mred\x1b[0m")).toBe("[31mred [0m");
    expect(sanitizeRemoteText("a\n\n b\tc")).toBe("a b c");
    expect(sanitizeRemoteText("x\u009by\x7fz")).toBe("x y z");
    expect(sanitizeRemoteText("  hi  ")).toBe("hi");
  });
  test("caps length with an ellipsis", () => {
    expect(sanitizeRemoteText("abcdef", 3)).toBe("abc…");
    expect(sanitizeRemoteText("abc", 3)).toBe("abc");
    expect(sanitizeRemoteText("a".repeat(400)).length).toBe(301);
  });
});
