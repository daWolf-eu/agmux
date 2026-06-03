import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "adapters", "claude", "plugin");

test("plugin.json declares the agmux plugin manifest", () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  expect(p.name).toBe("agmux");
  expect(typeof p.version).toBe("string");
});

test("hooks.json wires every capture point to `agmux emit`", () => {
  const h = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  const flat = JSON.stringify(h);
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "PostToolUse"]) expect(h.hooks[ev]).toBeDefined();
  for (const point of ["session.linked", "turn.started", "turn.ended", "input.required", "usage.reported", "tool.used"]) {
    expect(flat).toContain(`--point=${point}`);
  }
  expect(flat).toContain("--attach");
  expect(flat).toContain("--source=transcript-delta");
});

test("the emit shim resolves the agmux binary with a PATH fallback", () => {
  const shim = fs.readFileSync(path.join(ROOT, "bin", "agmux-emit"), "utf8");
  expect(shim).toContain("${AGMUX_BIN:-agmux}");
});
