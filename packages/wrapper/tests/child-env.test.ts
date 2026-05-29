import { test, expect } from "bun:test";
import { buildChildEnv } from "../src/child-env.ts";

test("buildChildEnv injects session id, hub url, profile env, and AGMUX_PROFILE", () => {
  const env = buildChildEnv(
    { PATH: "/usr/bin", UNDEF: undefined },
    { sessionId: "sid", hubUrl: "http://hub", profileEnv: { FOO: "bar" }, profileName: "work" },
  );
  expect(env.PATH).toBe("/usr/bin");
  expect(env.FOO).toBe("bar");
  expect(env.AGMUX_SESSION_ID).toBe("sid");
  expect(env.AGMUX_HUB_URL).toBe("http://hub");
  expect(env.AGMUX_PROFILE).toBe("work");
  expect("UNDEF" in env).toBe(false);
});

test("buildChildEnv omits AGMUX_PROFILE for a bare (null-profile) run", () => {
  const env = buildChildEnv({}, { sessionId: "sid", hubUrl: "http://hub", profileEnv: {}, profileName: null });
  expect("AGMUX_PROFILE" in env).toBe(false);
});
