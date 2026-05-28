import { test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadProfile, parseConfig } from "../src/profile.ts";

const sampleToml = `
[profiles.claude-work]
agent_kind = "claude"
command = "ccc"
args = []
env = { ANTHROPIC_LOG = "info" }

[profiles.codex-default]
agent_kind = "codex"
command = "codex"
args = ["--quiet"]
`;

test("parseConfig pulls profiles by name", () => {
  const cfg = parseConfig(sampleToml);
  expect(cfg.profiles["claude-work"]?.command).toBe("ccc");
  expect(cfg.profiles["codex-default"]?.args).toEqual(["--quiet"]);
});

test("parseConfig rejects unknown agent_kind", () => {
  const bad = `[profiles.x]\nagent_kind = "magic"\ncommand = "x"\n`;
  expect(() => parseConfig(bad)).toThrow(/agent_kind/);
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-cfg-"));
});

test("loadProfile reads the file and resolves a named profile", () => {
  const f = path.join(tmp, "config.toml");
  fs.writeFileSync(f, sampleToml);
  const p = loadProfile("claude-work", f);
  expect(p.command).toBe("ccc");
  expect(p.env).toEqual({ ANTHROPIC_LOG: "info" });
});

test("loadProfile throws on unknown profile name", () => {
  const f = path.join(tmp, "config.toml");
  fs.writeFileSync(f, sampleToml);
  expect(() => loadProfile("nope", f)).toThrow(/profile not found/);
});

test("loadProfile defaults args=[] and env={} when omitted", () => {
  const f = path.join(tmp, "config.toml");
  fs.writeFileSync(f, `[profiles.minimal]\nagent_kind="claude"\ncommand="cc"\n`);
  const p = loadProfile("minimal", f);
  expect(p.args).toEqual([]);
  expect(p.env).toEqual({});
});

