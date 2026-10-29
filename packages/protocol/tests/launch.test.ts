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

test("parsePrintedCoords accepts a coords line and rejects junk or a null pane", async () => {
  const { parsePrintedCoords } = await import("../src/launch.ts");
  const rt = { session: "agmux", window: "@1", pane: "%2", socket: null, server: "1-2" };
  expect(parsePrintedCoords(JSON.stringify({ remote_tmux: rt }))).toEqual(rt);
  expect(parsePrintedCoords(JSON.stringify({ remote_tmux: { ...rt, pane: null } }))).toBeNull();
  expect(parsePrintedCoords("not json")).toBeNull();
  expect(parsePrintedCoords("{}")).toBeNull();
});
