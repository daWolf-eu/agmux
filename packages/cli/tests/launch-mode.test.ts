import { test, expect } from "bun:test";
import { decideLaunchMode } from "../src/launch-mode.ts";

test("adapter present, not --wrapped → direct", () => {
  expect(decideLaunchMode({ wrapped: false, hasAdapter: true })).toBe("direct");
});

test("--wrapped forces wrapped even with adapter", () => {
  expect(decideLaunchMode({ wrapped: true, hasAdapter: true })).toBe("wrapped");
});

test("no adapter auto-wraps", () => {
  expect(decideLaunchMode({ wrapped: false, hasAdapter: false })).toBe("wrapped");
});

test("no adapter + --wrapped → wrapped", () => {
  expect(decideLaunchMode({ wrapped: true, hasAdapter: false })).toBe("wrapped");
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDefaultRegistry } from "@agmux/adapters";
import { claudeInstall } from "../../adapters/src/adapters/claude/install.ts";
import { parseRunArgs } from "../src/parse-run.ts";
import { planLaunch, type LocalRun } from "../src/launch-mode.ts";

function local(argv: string[]): LocalRun {
  const p = parseRunArgs(argv);
  if (p.kind !== "profile" && p.kind !== "inline") throw new Error(JSON.stringify(p));
  return p;
}

function planEnv(o: { env?: Record<string, string | undefined>; profiles?: Record<string, { agent_kind: "claude"; env: Record<string, string> }> } = {}) {
  const err: string[] = [];
  const deps = {
    registry: createDefaultRegistry(), env: o.env ?? {}, agmuxEmitPath: "agmux emit", stateDir: "/tmp/agmux-state",
    loadProfile: (name: string) => { const p = o.profiles?.[name]; if (!p) throw new Error(`profile not found: ${name}`); return p; },
    err: (l: string) => err.push(l),
  };
  return { deps, err };
}

const cfgDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agmux-plan-cfg-"));
const install = (dir: string) => claudeInstall({ agentKind: "claude", profile: null, profileEnv: {}, agmuxEmitPath: "agmux emit", stateDir: "/tmp/agmux-state", configDirOverride: dir });

test("planLaunch: a kind launch checks the process env's CLAUDE_CONFIG_DIR and runs the agent with it", () => {
  const dir = cfgDir();
  install(dir);
  const { deps, err } = planEnv({ env: { CLAUDE_CONFIG_DIR: dir, SECRET: "x" } });
  expect(planLaunch(local(["--direct", "--kind", "claude", "--", "claude"]), deps)).toEqual({
    mode: "direct", kind: "claude", agentEnv: { CLAUDE_CONFIG_DIR: dir },
  });
  expect(err).toEqual([]);
});

test("planLaunch: --direct with the adapter missing from that dir exits 2 naming the dir and the install command", () => {
  const dir = cfgDir();
  const { deps, err } = planEnv({ env: { CLAUDE_CONFIG_DIR: dir } });
  expect(planLaunch(local(["--direct", "claude"]), deps)).toEqual({ exitCode: 2 });
  expect(err).toHaveLength(1);
  expect(err[0]).toContain(dir);
  expect(err[0]).toContain(`agmux adapter install --kind claude --config-dir ${dir}`);
  expect(err[0]).not.toContain("launching wrapped");
});

test("planLaunch: without --direct a missing adapter falls back to wrapped with the hint", () => {
  const { deps, err } = planEnv({ env: { CLAUDE_CONFIG_DIR: cfgDir() } });
  expect(planLaunch(local(["claude"]), deps)).toMatchObject({ mode: "wrapped", kind: "claude" });
  expect(err[0]).toContain("launching wrapped for now");
});

test("planLaunch: a profile's env wins over the process env, and the agent runs with the whole profile env", () => {
  const dir = cfgDir();
  install(dir);
  const { deps } = planEnv({
    env: { CLAUDE_CONFIG_DIR: "/elsewhere" },
    profiles: { work: { agent_kind: "claude", env: { CLAUDE_CONFIG_DIR: dir, FOO: "bar" } } },
  });
  expect(planLaunch(local(["--direct", "-p", "work"]), deps)).toEqual({
    mode: "direct", kind: "claude", agentEnv: { CLAUDE_CONFIG_DIR: dir, FOO: "bar" },
  });
});

test("planLaunch: --direct with an unloadable profile exits 2", () => {
  const { deps, err } = planEnv();
  expect(planLaunch(local(["--direct", "-p", "nope"]), deps)).toEqual({ exitCode: 2 });
  expect(err[0]).toMatch(/no adapter for this agent/);
});
