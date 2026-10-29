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

test("strict (--direct): names the config dir checked and the install command for it, no wrapped fallback", () => {
  const adapter = { status: () => ({ installed: false, version: null, drift: false, configDir: "/s/.claude-chax" }) } as any;
  const lines: string[] = [];
  expect(adapterReadyOrHint(adapter, ctx, "claude", (s) => lines.push(s), true)).toBe(false);
  expect(lines).toEqual([
    "agmux run --direct: claude adapter not installed in /s/.claude-chax; cannot launch direct. Install it with: agmux adapter install --kind claude --config-dir /s/.claude-chax",
  ]);
});

test("strict: a status that throws is reported, not swallowed", () => {
  const adapter = { status: () => { throw new Error("boom"); } } as any;
  const lines: string[] = [];
  expect(adapterReadyOrHint(adapter, ctx, "claude", (s) => lines.push(s), true)).toBe(false);
  expect(lines).toEqual(["agmux run --direct: cannot read the claude adapter status: boom"]);
});
