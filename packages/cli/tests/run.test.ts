import { test, expect } from "bun:test";
import { buildDirectSpawn } from "../src/run.ts";

test("inline direct spawn uses the agent command + telemetry env, no claim", () => {
  const s = buildDirectSpawn({
    kind: "inline", mode: "direct", agent_kind: "claude", command: "claude", args: ["--foo"],
    hubUrl: "http://127.0.0.1:9", wrapBin: "agmux-wrap", placement: "inherit", detach: false, wrapped: false,
  } as any, "/usr/local/bin/agmux");
  expect(s.argv).toEqual(["claude", "--foo"]);
  expect(s.env.AGMUX_BIN).toBe("/usr/local/bin/agmux");
  expect(s.env.AGMUX_SESSION_ID).toBeUndefined(); // native: no claim
  expect(s.label).toBe("claude");
});
