import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installAdapter, uninstallAdapter, loadRecord, ledgerPath } from "../src/core/install.ts";
import { fakeAdapter } from "./fixtures/fake-adapter.ts";
import type { InstallContext } from "../src/core/types.ts";

function tmpState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-adapters-"));
}
function ctxFor(stateDir: string, profile: string | null): InstallContext {
  return {
    agentKind: "claude", profile, profileEnv: { FAKE_CONFIG_DIR: path.join(stateDir, "cfg") },
    agmuxEmitPath: "/abs/agmux emit", stateDir,
  };
}

test("ledgerPath encodes profile vs bare target", () => {
  expect(ledgerPath("/s", "claude", null)).toBe("/s/adapters/claude.json");
  expect(ledgerPath("/s", "claude", "work")).toBe("/s/adapters/claude@work.json");
});

test("installAdapter writes the ledger and adapter marker; uninstall reverses both", () => {
  const stateDir = tmpState();
  const ctx = ctxFor(stateDir, "work");

  const rec = installAdapter(fakeAdapter, ctx);
  expect(rec.agentKind).toBe("claude");
  expect(fs.existsSync(ledgerPath(stateDir, "claude", "work"))).toBe(true);
  expect(fakeAdapter.status(ctx).installed).toBe(true);

  const loaded = loadRecord(stateDir, "claude", "work");
  expect(loaded!.adapterVersion).toBe("1");
  expect(loaded!.capabilities["turn.started"].fulfil).toBe("yes");

  expect(uninstallAdapter(fakeAdapter, ctx)).toBe(true);
  expect(fs.existsSync(ledgerPath(stateDir, "claude", "work"))).toBe(false);
  expect(fakeAdapter.status(ctx).installed).toBe(false);
});

test("uninstallAdapter on a never-installed target returns false", () => {
  const stateDir = tmpState();
  expect(uninstallAdapter(fakeAdapter, ctxFor(stateDir, null))).toBe(false);
});

test("installAdapter is idempotent (re-install overwrites, single ledger file)", () => {
  const stateDir = tmpState();
  const ctx = ctxFor(stateDir, null);
  installAdapter(fakeAdapter, ctx);
  installAdapter(fakeAdapter, ctx);
  expect(fs.existsSync(ledgerPath(stateDir, "claude", null))).toBe(true);
  expect(loadRecord(stateDir, "claude", null)!.adapterVersion).toBe("1");
});
