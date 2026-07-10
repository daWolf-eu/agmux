import { test, expect } from "bun:test";
import { buildDirectSpawn, runInjectStep } from "../src/run.ts";

test("buildDirectSpawn inline leaves cwd undefined", () => {
  const s = buildDirectSpawn({
    kind: "inline", mode: "direct", agent_kind: "claude", command: "claude", args: [],
    hubUrl: "http://127.0.0.1:9", wrapBin: "agmux-wrap", placement: "inherit", detach: false, wrapped: false,
  } as any, "/usr/local/bin/agmux");
  expect(s.cwd).toBeUndefined();
});

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

test("runInjectStep returns null when no prompt is set", async () => {
  let called = false;
  const r = await runInjectStep(
    { pane: "%3", prompt: undefined, agentKind: "claude" },
    async () => { called = true; return { outcome: "submitted" as const }; },
  );
  expect(r).toBeNull();
  expect(called).toBe(false);
});

test("runInjectStep invokes the injector with the pane and returns a report line", async () => {
  let seenPane = "";
  const r = await runInjectStep(
    { pane: "%7", prompt: "do X", agentKind: "claude" },
    async (o) => { seenPane = o.pane; return { outcome: "submitted" as const }; },
  );
  expect(seenPane).toBe("%7");
  expect(r).toMatch(/prompt injected/);
});

test("runInjectStep never throws even if the injector rejects", async () => {
  const r = await runInjectStep(
    { pane: "%9", prompt: "boom", agentKind: "claude" },
    async () => { throw new Error("kaboom"); },
  );
  expect(r).toMatch(/failed/);
});
