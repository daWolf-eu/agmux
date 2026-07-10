import { test, expect } from "bun:test";
import { pickEnv } from "../src/core/env-capture.ts";

test("captures only declared keys that are present and non-empty", () => {
  const env = { CLAUDE_CONFIG_DIR: "/x", PATH: "/bin", EMPTY: "" };
  expect(pickEnv(["CLAUDE_CONFIG_DIR", "EMPTY"], env)).toEqual({ CLAUDE_CONFIG_DIR: "/x" });
});

test("never captures an undeclared variable (secrets guard)", () => {
  const env = { CLAUDE_CONFIG_DIR: "/x", SECRET_TOKEN: "shhh", AWS_SECRET_ACCESS_KEY: "nope" };
  const out = pickEnv(["CLAUDE_CONFIG_DIR"], env);
  expect(out).toEqual({ CLAUDE_CONFIG_DIR: "/x" });
  expect(out.SECRET_TOKEN).toBeUndefined();
  expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
});

test("empty key list captures nothing; missing env is safe", () => {
  expect(pickEnv([], { CLAUDE_CONFIG_DIR: "/x" })).toEqual({});
  expect(pickEnv(["CLAUDE_CONFIG_DIR"], undefined)).toEqual({});
});
