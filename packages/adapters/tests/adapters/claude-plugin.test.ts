import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "adapters", "claude", "marketplace");

test("marketplace.json declares the local agmux plugin", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  expect(m.name).toBe("agmux");
  // Local plugin entries use a relative-path STRING (live-verified against
  // claude 2.1.156; the older {source:"local",path} object form is rejected).
  expect(m.plugins[0]).toMatchObject({ name: "agmux", source: "./plugins/agmux" });
});

test("hooks.json wires every capture point to `agmux emit`", () => {
  const h = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "agmux", "hooks", "hooks.json"), "utf8"));
  const flat = JSON.stringify(h);
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "PostToolUse"]) expect(h.hooks[ev]).toBeDefined();
  for (const point of ["session.linked", "turn.started", "turn.ended", "input.required", "usage.reported", "tool.used"]) {
    expect(flat).toContain(`--point=${point}`);
  }
  expect(flat).toContain("--attach");
  expect(flat).toContain("--source=transcript-delta");
});

test("the emit shim resolves the agmux binary with a PATH fallback", () => {
  const shim = fs.readFileSync(path.join(ROOT, "plugins", "agmux", "bin", "agmux-emit"), "utf8");
  expect(shim).toContain("${AGMUX_BIN:-agmux}");
});
