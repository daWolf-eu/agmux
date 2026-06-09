import { test, expect } from "bun:test";
import { adapterReadyOrHint } from "../src/adapter-ready.ts";

function fakeAdapter(state: { installed: boolean; drift: boolean }) {
  const calls = { install: 0, status: 0 };
  const adapter = {
    status: () => { calls.status++; return { installed: state.installed, version: "1", drift: state.drift, runtimeGate: "none" as const }; },
    install: () => { calls.install++; return {} as any; },
  } as any;
  return { adapter, calls };
}
const ctx = {} as any;

test("ready when installed and current — no hint, never installs", () => {
  const { adapter, calls } = fakeAdapter({ installed: true, drift: false });
  const lines: string[] = [];
  expect(adapterReadyOrHint(adapter, ctx, "claude", (s) => lines.push(s))).toBe(true);
  expect(calls.install).toBe(0);
  expect(lines).toHaveLength(0);
});

test("not installed → hint, returns false, NEVER installs", () => {
  const { adapter, calls } = fakeAdapter({ installed: false, drift: false });
  const lines: string[] = [];
  expect(adapterReadyOrHint(adapter, ctx, "claude", (s) => lines.push(s))).toBe(false);
  expect(calls.install).toBe(0);
  expect(lines.join("\n")).toContain("agmux adapter install --kind claude");
});

test("drifted → hint, returns false, never installs", () => {
  const { adapter, calls } = fakeAdapter({ installed: true, drift: true });
  const lines: string[] = [];
  expect(adapterReadyOrHint(adapter, ctx, "claude", (s) => lines.push(s))).toBe(false);
  expect(calls.install).toBe(0);
  expect(lines.join("\n")).toContain("agmux adapter install --kind claude");
});

test("status throws → not ready, swallowed (no throw)", () => {
  const adapter = { status: () => { throw new Error("boom"); } } as any;
  expect(adapterReadyOrHint(adapter, ctx, "claude", () => {})).toBe(false);
});
