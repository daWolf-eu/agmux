import { test, expect } from "bun:test";
import { scrubTmuxEnv, planFor, headlessProfile } from "../src/headless.ts";
import { parseRunArgs } from "../src/parse-run.ts";
import { createDefaultRegistry } from "@agmux/adapters";

const registry = createDefaultRegistry();
const profile = (agent_kind: "claude" | "codex" | "pi", command = agent_kind) =>
  ({ agent_kind, command, args: [] as string[], env: {} as Record<string, string> });

const base = {
  profileName: null, prompt: "summarize", hubUrl: "http://127.0.0.1:1",
  stateDir: "/tmp/nope", registry,
};

test("scrubTmuxEnv drops TMUX and TMUX_PANE, keeps everything else", () => {
  const out = scrubTmuxEnv({
    TMUX: "/private/tmp/tmux-501/default,123,0",
    TMUX_PANE: "%28",
    PATH: "/usr/bin",
    CLAUDE_CONFIG_DIR: "~/.claude-chax",
  });
  expect(out).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "~/.claude-chax" });
});

test("scrubTmuxEnv drops undefined values", () => {
  expect(scrubTmuxEnv({ A: "1", B: undefined })).toEqual({ A: "1" });
});

test("claude headless plan puts the prompt behind -p", () => {
  const plan = planFor({ ...base, profile: profile("claude") }, "/w", {});
  expect(plan.supported).toBe(true);
  expect(plan.argv).toEqual(["claude", "-p", "summarize"]);
});

test("claude headless plan keeps profile args before -p", () => {
  const p = { ...profile("claude"), args: ["--model", "opus"] };
  const plan = planFor({ ...base, profile: p }, "/w", {});
  expect(plan.argv).toEqual(["claude", "--model", "opus", "-p", "summarize"]);
});

test("codex headless plan uses the exec subcommand with a trailing prompt", () => {
  const plan = planFor({ ...base, profile: profile("codex") }, "/w", {});
  expect(plan.supported).toBe(true);
  expect(plan.argv).toEqual(["codex", "exec", "summarize"]);
});

test("pi reports headless as unsupported rather than spawning", () => {
  const plan = planFor({ ...base, profile: profile("pi") }, "/w", {});
  expect(plan.supported).toBe(false);
  expect(plan.argv).toBeUndefined();
});

test("plan carries cwd and env through", () => {
  const plan = planFor({ ...base, profile: profile("claude") }, "/w", { FOO: "bar" });
  expect(plan.cwd).toBe("/w");
  expect(plan.env).toEqual({ FOO: "bar" });
});

test("headlessProfile: --cwd sets the cwd of an inline headless run", () => {
  const p = parseRunArgs(["--headless", "--prompt", "x", "--cwd", "/sandbox/work", "--", "claude", "--y"]);
  if (p.kind !== "inline") throw new Error(p.kind);
  expect(headlessProfile(p, () => { throw new Error("no load"); })).toEqual({
    profile: { agent_kind: "claude", command: "claude", args: ["--y"], env: {}, cwd: "/sandbox/work" }, profileName: null,
  });
});

test("headlessProfile: --cwd overrides a loaded profile's cwd; without it the profile's stays", () => {
  const load = (name: string) => ({ ...profile("codex"), cwd: `/from/${name}` });
  const withCwd = parseRunArgs(["--headless", "--prompt", "x", "--cwd", "/o", "-p", "work"]);
  const without = parseRunArgs(["--headless", "--prompt", "x", "-p", "work"]);
  if (withCwd.kind !== "profile" || without.kind !== "profile") throw new Error("parse");
  expect(headlessProfile(withCwd, load)).toEqual({ profile: { ...profile("codex"), cwd: "/o" }, profileName: "work" });
  expect(headlessProfile(without, load).profile.cwd).toBe("/from/work");
});
