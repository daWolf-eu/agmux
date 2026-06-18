import { test, expect } from "bun:test";
import { PI_SOURCES, PI_CAPABILITIES } from "../../src/adapters/pi/caps.ts";
import { isManifestPoint } from "../../src/core/manifest.ts";

test("every pi source point is a valid manifest point", () => {
  for (const s of PI_SOURCES) for (const p of s.points) expect(isManifestPoint(p)).toBe(true);
});

test("every fulfilled pi capability is covered by a source", () => {
  const covered = new Set(PI_SOURCES.flatMap((s) => s.points as string[]));
  for (const [pt, d] of Object.entries(PI_CAPABILITIES)) {
    if (d.fulfil !== "no") expect(covered.has(pt)).toBe(true);
  }
});

test("usage is hook-command + live (no transcript tailing); input.required is absent", () => {
  expect(PI_CAPABILITIES["usage.reported"]).toMatchObject({ source: "hook-command", liveness: "live" });
  expect(PI_CAPABILITIES["turn.started"]).toMatchObject({ source: "hook-command", liveness: "live" });
  expect(PI_CAPABILITIES["input.required"]).toBeUndefined();
});
