import { test, expect } from "bun:test";
import { parseLaunchSpec } from "../src/launch.ts";

test("parses a valid spec", () => {
  expect(parseLaunchSpec('{"profile":"p","command":"claude","args":["-x"]}')).toEqual({ profile: "p", command: "claude", args: ["-x"] });
  expect(parseLaunchSpec('{"profile":null,"command":"claude","args":[]}')?.profile).toBeNull();
});

test("null on absent, invalid JSON, or wrong types", () => {
  for (const s of [undefined, "", "{nope", "[]", "null", '{"profile":null,"command":"","args":[]}',
    '{"profile":null,"command":"c","args":[1]}', '{"profile":1,"command":"c","args":[]}', '{"command":"c","args":[]}']) {
    expect(parseLaunchSpec(s)).toBeNull();
  }
});
