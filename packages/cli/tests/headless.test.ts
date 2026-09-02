import { test, expect } from "bun:test";
import { scrubTmuxEnv, planFor } from "../src/headless.ts";
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
