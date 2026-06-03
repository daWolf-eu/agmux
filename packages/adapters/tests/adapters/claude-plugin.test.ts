import { test, expect } from "bun:test";
import { PLUGIN_FILES, PLUGIN_VERSION } from "../../src/adapters/claude/plugin-files.ts";

function file(p: string) {
  const f = PLUGIN_FILES.find((f) => f.path === p);
  if (!f) throw new Error(`plugin file missing: ${p}`);
  return f;
}

test("plugin payload declares the agmux plugin manifest", () => {
  const m = JSON.parse(file(".claude-plugin/plugin.json").content);
  expect(m.name).toBe("agmux");
  expect(m.version).toBe(PLUGIN_VERSION);
});

test("hooks.json wires every capture point to `agmux emit`", () => {
  const h = JSON.parse(file("hooks/hooks.json").content);
  const flat = file("hooks/hooks.json").content;
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "PostToolUse"]) expect(h.hooks[ev]).toBeDefined();
  for (const point of ["session.linked", "turn.started", "turn.ended", "input.required", "usage.reported", "tool.used"]) {
    expect(flat).toContain(`--point=${point}`);
  }
  expect(flat).toContain("--attach");
  expect(flat).toContain("--source=transcript-delta");
});

test("every hook is async so it never delays Claude", () => {
  const h = JSON.parse(file("hooks/hooks.json").content);
  for (const groups of Object.values<any>(h.hooks)) {
    for (const g of groups) for (const hook of g.hooks) expect(hook.async).toBe(true);
  }
});

test("the emit shim resolves the agmux binary with a PATH fallback and is executable", () => {
  const shim = file("bin/agmux-emit");
  expect(shim.content).toContain("${AGMUX_BIN:-agmux}");
  expect(shim.content.startsWith("#!/usr/bin/env bash")).toBe(true);
  expect(shim.mode & 0o111).not.toBe(0);
});

test("SessionStart re-links on clear/compact (native id rotates mid-process)", () => {
  const h = JSON.parse(file("hooks/hooks.json").content);
  expect(h.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
});
