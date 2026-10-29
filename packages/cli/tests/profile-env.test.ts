import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadProfileEnvFrom, loadProfileLaunchFrom } from "../src/profile-env.ts";

function tmpConfig(toml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-pe-"));
  const p = path.join(dir, "config.toml");
  fs.writeFileSync(p, toml);
  return p;
}

test("returns the profile's env (tilde-expanded by loadProfile)", () => {
  const cfg = tmpConfig(`[profiles.work]\nagent_kind = "claude"\ncommand = "claude"\nargs = []\nenv = { CLAUDE_CONFIG_DIR = "~/.claude-chax" }\n`);
  const env = loadProfileEnvFrom("work", cfg)!;
  expect(env.CLAUDE_CONFIG_DIR).toBe(os.homedir() + "/.claude-chax");
});

test("missing profile or config → undefined (never throws)", () => {
  const cfg = tmpConfig(`[profiles.work]\nagent_kind = "claude"\ncommand = "claude"\nargs = []\n`);
  expect(loadProfileEnvFrom("nope", cfg)).toBeUndefined();
  expect(loadProfileEnvFrom("work", "/does/not/exist.toml")).toBeUndefined();
});

test("loadProfileLaunchFrom returns command, args and env; undefined when missing", () => {
  const cfg = tmpConfig(`[profiles.work]\nagent_kind = "claude"\ncommand = "claude"\nargs = ["--model", "x"]\nenv = { A = "~/a" }\n`);
  expect(loadProfileLaunchFrom("work", cfg)).toEqual({ command: "claude", args: ["--model", "x"], env: { A: os.homedir() + "/a" } });
  expect(loadProfileLaunchFrom("nope", cfg)).toBeUndefined();
  expect(loadProfileLaunchFrom("work", "/does/not/exist.toml")).toBeUndefined();
});
