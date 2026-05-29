import { test, expect } from "bun:test";
import { createRegistry } from "../src/core/registry.ts";
import type { Adapter } from "../src/core/types.ts";

function stub(kind: "claude" | "codex"): Adapter {
  return {
    agentKind: kind, adapterVersion: "1",
    sources: () => [], capabilities: () => ({}),
    install: () => ({ agentKind: kind, profile: null, adapterVersion: "1", isolationMode: "config-dir", capabilities: {}, artifacts: [] }),
    uninstall: () => {}, status: () => ({ installed: false, version: null, drift: false }),
    normalize: () => ({ events: [] }),
    resumePlan: () => ({ resumable: false }),
  };
}

test("register then lookup returns the adapter", () => {
  const r = createRegistry();
  const a = stub("claude");
  r.register(a);
  expect(r.lookup("claude")).toBe(a);
  expect(r.lookup("codex")).toBeNull();
  expect(r.kinds()).toEqual(["claude"]);
});

test("double-registering the same kind throws", () => {
  const r = createRegistry();
  r.register(stub("claude"));
  expect(() => r.register(stub("claude"))).toThrow(/already registered/);
});
