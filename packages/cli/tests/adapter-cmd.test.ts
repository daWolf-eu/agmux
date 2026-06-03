import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAdapterCmd } from "../src/adapter-cmd.ts";
import { createRegistry, loadRecord } from "@agmux/adapters";
import { fakeAdapter } from "@agmux/adapters/testing";

function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-adpcmd-"));
  const configPath = path.join(stateDir, "config.toml");
  // A profile whose agent_kind is claude (the fake adapter's kind).
  fs.writeFileSync(configPath, [
    `[profiles.work]`,
    `agent_kind = "claude"`,
    `command = "claude"`,
    `env = { FAKE_CONFIG_DIR = "${path.join(stateDir, "work-cfg")}" }`,
  ].join("\n"));
  const out: string[] = [];
  const reg = createRegistry(); reg.register(fakeAdapter);
  return {
    stateDir, configPath, out,
    deps: { registry: reg, stateDir, configPath, agmuxEmitPath: "/abs/agmux emit", out: (s: string) => out.push(s) },
  };
}

test("adapter install <profile> writes a ledger and reports success", async () => {
  const s = setup();
  const rc = await runAdapterCmd(["install", "work"], s.deps);
  expect(rc).toBe(0);
  expect(loadRecord(s.stateDir, "claude", "work")).not.toBeNull();
  expect(s.out.join("\n")).toMatch(/installed claude@work/);
});

test("adapter status reflects install then uninstall", async () => {
  const s = setup();
  await runAdapterCmd(["install", "work"], s.deps);
  await runAdapterCmd(["status", "work"], s.deps);
  expect(s.out.join("\n")).toMatch(/installed/);

  const rc = await runAdapterCmd(["uninstall", "work"], s.deps);
  expect(rc).toBe(0);
  expect(loadRecord(s.stateDir, "claude", "work")).toBeNull();
});

test("adapter install --kind claude targets the bare kind", async () => {
  const s = setup();
  const rc = await runAdapterCmd(["install", "--kind", "claude"], s.deps);
  expect(rc).toBe(0);
  expect(loadRecord(s.stateDir, "claude", null)).not.toBeNull();
  expect(s.out.join("\n")).toMatch(/installed claude \(bare\)/);
});

test("adapter install for a kind with no registered adapter errors cleanly", async () => {
  const s = setup();
  const rc = await runAdapterCmd(["install", "--kind", "codex"], s.deps);
  expect(rc).toBe(1);
  expect(s.out.join("\n")).toMatch(/no adapter registered for kind 'codex'/);
});

test("adapter list shows registered kinds and install state", async () => {
  const s = setup();
  await runAdapterCmd(["install", "work"], s.deps);
  await runAdapterCmd(["list"], s.deps);
  const text = s.out.join("\n");
  expect(text).toMatch(/claude/);
  expect(text).toMatch(/work/);
});

test("adapter install --config-dir threads the override into the InstallContext", async () => {
  const s = setup();
  let seen: any = null;
  const spy = {
    ...fakeAdapter,
    install: (ctx: any) => { seen = ctx; return fakeAdapter.install(ctx); },
  };
  const reg = createRegistry(); reg.register(spy);
  const rc = await runAdapterCmd(["install", "--config-dir", "/custom/cfg", "work"], { ...s.deps, registry: reg });
  expect(rc).toBe(0);
  expect(seen.configDirOverride).toBe("/custom/cfg");
  expect(seen.profile).toBe("work"); // flag value must not be mistaken for the profile name
});

test("adapter status without --config-dir leaves the override unset", async () => {
  const s = setup();
  let seen: any = null;
  const spy = { ...fakeAdapter, status: (ctx: any) => { seen = ctx; return fakeAdapter.status(ctx); } };
  const reg = createRegistry(); reg.register(spy);
  await runAdapterCmd(["status", "work"], { ...s.deps, registry: reg });
  expect(seen.configDirOverride ?? null).toBeNull();
});
