import { test, expect } from "bun:test";
import { CLAUDE_SOURCES, CLAUDE_CAPABILITIES } from "../../src/adapters/claude/caps.ts";
import { isManifestPoint } from "../../src/core/manifest.ts";

test("every source point is a valid manifest point", () => {
  for (const s of CLAUDE_SOURCES) for (const p of s.points) expect(isManifestPoint(p)).toBe(true);
});

test("every fulfilled capability is covered by a source", () => {
  const covered = new Set(CLAUDE_SOURCES.flatMap((s) => s.points as string[]));
  for (const [pt, d] of Object.entries(CLAUDE_CAPABILITIES)) {
    if (d.fulfil !== "no") expect(covered.has(pt)).toBe(true);
  }
});

test("usage is transcript-delta + backfilled; turns are hook-command + live", () => {
  expect(CLAUDE_CAPABILITIES["usage.reported"]).toMatchObject({ source: "transcript-delta", liveness: "backfilled" });
  expect(CLAUDE_CAPABILITIES["turn.started"]).toMatchObject({ source: "hook-command", liveness: "live" });
  expect(CLAUDE_CAPABILITIES["input.required"]?.fulfil).toBe("partial");
});
