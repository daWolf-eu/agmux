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

import { codexResumePlan } from "../../src/adapters/codex/resume.ts";

const resumeCtx = (nid: string | null) => ({
  agentKind: "codex" as const, profile: null, command: "codex", args: ["--model", "gpt-5.5"],
  cwd: "/work", env: { FOO: "1" }, nativeSessionId: nid,
});

test("codex resumePlan builds `codex resume <id>` preserving original args", () => {
  const plan = codexResumePlan(resumeCtx("019e7396-de62-7f91-9a3d-df4b0a99aaaf"));
  expect(plan.resumable).toBe(true);
  expect(plan.argv).toEqual(["codex", "resume", "019e7396-de62-7f91-9a3d-df4b0a99aaaf", "--model", "gpt-5.5"]);
  expect(plan.cwd).toBe("/work");
  expect(plan.nativeSessionId).toBe("019e7396-de62-7f91-9a3d-df4b0a99aaaf");
});

test("codex resumePlan is not resumable without a native session id", () => {
  expect(codexResumePlan(resumeCtx(null))).toEqual({ resumable: false });
});
