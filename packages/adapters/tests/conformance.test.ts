import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertAdapterConformance } from "../src/core/conformance.ts";
import { fakeAdapter } from "./fixtures/fake-adapter.ts";
import type { Adapter, InstallContext, ResumeContext } from "../src/core/types.ts";

function harness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-conf-"));
  const makeContext = (): InstallContext => ({
    agentKind: "claude", profile: null, profileEnv: { FAKE_CONFIG_DIR: path.join(stateDir, "cfg") },
    agmuxEmitPath: "/abs/agmux emit", stateDir,
  });
  const makeResumeContext = (nid: string | null): ResumeContext => ({
    agentKind: "claude", profile: null, command: "claude", args: [], cwd: "/tmp", env: {}, nativeSessionId: nid,
  });
  return { makeContext, makeResumeContext };
}

test("the fake adapter passes the full conformance battery", () => {
  const passed = assertAdapterConformance(fakeAdapter, harness());
  expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan"]);
});

test("conformance rejects a capability not covered by any source", () => {
  const broken: Adapter = {
    ...fakeAdapter,
    sources: () => [],                            // declares NO sources...
    capabilities: () => ({ "turn.started": { fulfil: "yes" } }), // ...but claims a capability
  };
  expect(() => assertAdapterConformance(broken, harness())).toThrow(/no source covers it/);
});

test("conformance rejects a source pointing at a non-manifest point", () => {
  const broken: Adapter = {
    ...fakeAdapter,
    sources: () => [{ type: "hook-command", activation: "event-triggered", points: ["bogus.point" as any] }],
  };
  expect(() => assertAdapterConformance(broken, harness())).toThrow(/not a manifest point/);
});

test("conformance rejects a resumable plan with no argv", () => {
  const broken: Adapter = {
    ...fakeAdapter,
    resumePlan: () => ({ resumable: true }), // resumable but no argv
  };
  expect(() => assertAdapterConformance(broken, harness())).toThrow(/non-empty argv/);
});
