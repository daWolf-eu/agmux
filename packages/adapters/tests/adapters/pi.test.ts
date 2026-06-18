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

import { piResumePlan } from "../../src/adapters/pi/resume.ts";

const resumeCtx = (nid: string | null) => ({
  agentKind: "pi" as const, profile: null, command: "pi", args: ["--model", "gpt-5.5"],
  cwd: "/work", env: { FOO: "1" }, nativeSessionId: nid,
});

test("pi resumePlan builds `pi --session <id>` preserving original args", () => {
  const plan = piResumePlan(resumeCtx("019e6415-f214-72d2-8352-afd93f03133c"));
  expect(plan.resumable).toBe(true);
  expect(plan.argv).toEqual(["pi", "--session", "019e6415-f214-72d2-8352-afd93f03133c", "--model", "gpt-5.5"]);
  expect(plan.cwd).toBe("/work");
  expect(plan.nativeSessionId).toBe("019e6415-f214-72d2-8352-afd93f03133c");
});

test("pi resumePlan is not resumable without a native session id", () => {
  expect(piResumePlan(resumeCtx(null))).toEqual({ resumable: false });
});
