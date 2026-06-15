import { test, expect } from "bun:test";
import { CODEX_SOURCES, CODEX_CAPABILITIES } from "../../src/adapters/codex/caps.ts";
import { isManifestPoint } from "../../src/core/manifest.ts";

test("every codex source point is a valid manifest point", () => {
  for (const s of CODEX_SOURCES) for (const p of s.points) expect(isManifestPoint(p)).toBe(true);
});

test("every fulfilled codex capability is covered by a source", () => {
  const covered = new Set(CODEX_SOURCES.flatMap((s) => s.points as string[]));
  for (const [pt, d] of Object.entries(CODEX_CAPABILITIES)) {
    if (d.fulfil !== "no") expect(covered.has(pt)).toBe(true);
  }
});

test("usage is transcript-delta + backfilled; turns are hook-command + live; input.required partial", () => {
  expect(CODEX_CAPABILITIES["usage.reported"]).toMatchObject({ source: "transcript-delta", liveness: "backfilled" });
  expect(CODEX_CAPABILITIES["turn.started"]).toMatchObject({ source: "hook-command", liveness: "live" });
  expect(CODEX_CAPABILITIES["input.required"]?.fulfil).toBe("partial");
});
