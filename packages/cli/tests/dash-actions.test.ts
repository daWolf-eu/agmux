import { test, expect } from "bun:test";
import { deltaEnv } from "../src/dash-actions.ts";

test("deltaEnv returns only keys whose value differs from base", () => {
  const base = { PATH: "/bin", HOME: "/home/x" };
  const spec = { PATH: "/bin", HOME: "/home/x", AGMUX_SESSION_ID: "abc", AGMUX_HUB_URL: "http://h" };
  expect(deltaEnv(spec, base)).toEqual({ AGMUX_SESSION_ID: "abc", AGMUX_HUB_URL: "http://h" });
});

test("deltaEnv includes keys missing from base", () => {
  expect(deltaEnv({ A: "1" }, {})).toEqual({ A: "1" });
});
