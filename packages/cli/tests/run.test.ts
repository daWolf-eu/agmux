import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

import { runCmd, type PrintCoordsDeps } from "../src/run.ts";
import { parsePrintedCoords } from "@agmux/protocol";

const baseOpts = {
  kind: "inline", mode: "direct", agent_kind: "claude", command: "claude", args: ["--dangerously-skip-permissions", "a b"],
  hubUrl: "http://127.0.0.1:9", wrapBin: "agmux-wrap", placement: "print-coords", detach: true,
} as any;

function fakeDeps(sessionExists: boolean) {
  const calls: { fn: string; args: any }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const coords = { session: "agmux", window: "@3", pane: "%5", socket: null };
  const deps: PrintCoordsDeps = {
    hasSession: async () => sessionExists,
    newWindow: async (a) => { calls.push({ fn: "newWindow", args: a }); return coords; },
    newSession: async (a) => { calls.push({ fn: "newSession", args: a }); return coords; },
    tmuxServerId: async () => "123-456",
    inject: async () => ({ outcome: "submitted" as const }),
    out: (l) => out.push(l), err: (l) => err.push(l),
  };
  return { deps, calls, out, err };
}

test("print-coords on a missing session uses newSession; stdout is one parsable line", async () => {
  const f = fakeDeps(false);
  expect(await runCmd({ ...baseOpts, prompt: "hi" }, "agmux", f.deps)).toBe(0);
  expect(f.calls.map((c) => c.fn)).toEqual(["newSession"]);
  expect(f.out).toHaveLength(1);
  expect(parsePrintedCoords(f.out[0]!)).toEqual({ session: "agmux", window: "@3", pane: "%5", socket: null, server: "123-456" });
  expect(f.err.join("\n")).toMatch(/spawned in agmux:@3\.%5/);
  expect(f.err.join("\n")).toMatch(/prompt injected/);
});

test("print-coords on an existing session opens a detached window with AGMUX_LAUNCH and --cwd", async () => {
  const f = fakeDeps(true);
  await runCmd({ ...baseOpts, cwd: "/w" }, "agmux", f.deps);
  expect(f.calls[0]!.fn).toBe("newWindow");
  const a = f.calls[0]!.args;
  expect(a.detach).toBe(true);
  expect(a.socket).toBeNull();
  expect(a.cwd).toBe("/w");
  expect(JSON.parse(a.env.AGMUX_LAUNCH)).toEqual({ profile: null, command: "claude", args: ["--dangerously-skip-permissions", "a b"] });
});

test("buildDirectSpawn: --cwd wins over profile cwd", () => {
  const s = buildDirectSpawn({ ...baseOpts, placement: "inherit", cwd: "/x" }, "agmux");
  expect(s.cwd).toBe("/x");
});

test("buildDirectSpawn: the agent runs with agentEnv; agmux's own keys win", () => {
  const s = buildDirectSpawn({ ...baseOpts, placement: "inherit", agentEnv: { CLAUDE_CONFIG_DIR: "/c", AGMUX_BIN: "evil" } }, "agmux");
  expect(s.env.CLAUDE_CONFIG_DIR).toBe("/c");
  expect(s.env.AGMUX_BIN).toBe("agmux");
});

test("buildDirectSpawn: a profile launch passes the profile env to the agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-run-cfg-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, [
    `[profiles.work]`, `agent_kind = "claude"`, `command = "claude"`, `env = { CLAUDE_CONFIG_DIR = "/sandbox/.claude-chax" }`,
  ].join("\n"));
  const s = buildDirectSpawn({ kind: "profile", profileName: "work", mode: "direct", hubUrl: "http://h", wrapBin: "w", placement: "inherit", detach: false }, "agmux", configPath);
  expect(s.env.CLAUDE_CONFIG_DIR).toBe("/sandbox/.claude-chax");
  expect(s.env.AGMUX_PROFILE).toBe("work");
});
