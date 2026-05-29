import { test, expect } from "bun:test";
import { MANIFEST_POINTS, isManifestPoint } from "../src/core/manifest.ts";

test("MANIFEST_POINTS contains the canonical hook-points", () => {
  expect(MANIFEST_POINTS).toContain("turn.started");
  expect(MANIFEST_POINTS).toContain("usage.reported");
  expect(MANIFEST_POINTS).not.toContain("session.adapter_attached"); // framework-emitted, not a point
});

test("isManifestPoint narrows valid and rejects invalid", () => {
  expect(isManifestPoint("turn.ended")).toBe(true);
  expect(isManifestPoint("session.adapter_attached")).toBe(false);
  expect(isManifestPoint("totally.made.up")).toBe(false);
});
