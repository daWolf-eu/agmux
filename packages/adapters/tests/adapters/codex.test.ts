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

import { normalizeCodex } from "../../src/adapters/codex/normalize.ts";

const target = { agentKind: "codex" as const, profile: null };

test("session.registered builds the native lifecycle root from stdin + env", () => {
  const out = normalizeCodex({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-9", cwd: "/work" }, target,
    env: { AGMUX_AGENT_PID: "5151", TMUX_PANE: "%4", AGMUX_PROFILE: "work", CODEX_VERSION: "0.135.0" },
  });
  expect(out.events).toHaveLength(1);
  const p = out.events[0]!.payload as any;
  expect(out.events[0]!.kind).toBe("session.registered");
  expect(p.native_session_id).toBe("nat-9");
  expect(p.agent_kind).toBe("codex");
  expect(p.pid).toBe(5151);
  expect(p.cwd).toBe("/work");
  expect(p.tmux_pane).toBe("%4");
  expect(p.profile).toBe("work");
  expect(p.agent_version).toBe("0.135.0");
  expect(p.parent).toBeNull();
});

test("session.registered stores null pid when AGMUX_AGENT_PID is absent/garbage", () => {
  const out = normalizeCodex({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-x" }, target, env: { AGMUX_AGENT_PID: "notanum" },
  });
  expect((out.events[0]!.payload as any).pid).toBeNull();
});

test("session.registered/linked are no-ops without a session_id", () => {
  expect(normalizeCodex({ point: "session.registered", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
  expect(normalizeCodex({ point: "session.linked", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
});

test("session.linked maps native session id from stdin", () => {
  const out = normalizeCodex({ point: "session.linked", source: "hook-command", raw: { session_id: "sess-abc" }, target });
  expect(out.events).toEqual([{ kind: "session.linked", payload: { native_session_id: "sess-abc" } }]);
});

test("turn.started / turn.ended map to canonical events", () => {
  expect(normalizeCodex({ point: "turn.started", source: "hook-command", raw: {}, target }).events[0]?.kind).toBe("turn.started");
  const ended = normalizeCodex({ point: "turn.ended", source: "hook-command", raw: { reason: "completed" }, target });
  expect(ended.events[0]).toEqual({ kind: "turn.ended", payload: { reason: "completed" } });
});

test("input.required is always a permission (Codex PermissionRequest is permission-only)", () => {
  expect(normalizeCodex({ point: "input.required", source: "hook-command", raw: {}, target }).events[0]?.payload).toEqual({ kind: "permission" });
});

test("prompt.sent is redacted (chars only); tool.used carries the tool name", () => {
  expect(normalizeCodex({ point: "prompt.sent", source: "hook-command", raw: { prompt: "hello" }, target }).events[0]?.payload).toEqual({ chars: 5, redacted: true });
  expect(normalizeCodex({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash" }, target }).events[0]?.payload).toEqual({ tool: "Bash", ok: true });
});

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const transcript = path.join(FX, "transcript.sample.jsonl");

test("usage.reported reads token_count deltas (last_token_usage) and advances the cursor", () => {
  const out = normalizeCodex({
    point: "usage.reported", source: "transcript-delta",
    raw: { session_id: "sess-x", transcript_path: transcript, model: "gpt-5.5", turn_id: "t-1" },
    cursor: null, target,
  });
  expect(out.events).toHaveLength(2); // two token_count records; response_item skipped
  expect(out.events[0]).toMatchObject({
    kind: "usage.reported",
    payload: {
      cumulative: false, source: "transcript-delta", model: "gpt-5.5",
      input_tokens: 10768, output_tokens: 270, cache_read_tokens: 1920, cache_write_tokens: null,
      reasoning_output_tokens: 82, total_tokens: 11038, model_context_window: 258400, turn_id: "t-1",
    },
  });
  expect((out.events[0]!.payload as any).rate_limit).toMatchObject({ used_percent: 5.0 });
  // Second record carries its own per-turn delta (last_token_usage, not the cumulative total).
  expect(out.events[1]!.payload).toMatchObject({ input_tokens: 15029, output_tokens: 381, cache_read_tokens: 10624 });

  // dedup keys are byte-offset based, distinct, and monotonic.
  const k0 = out.events[0]!.dedup_key!;
  const k1 = out.events[1]!.dedup_key!;
  expect(k0).toMatch(/^codex:transcript-delta:sess-x:\d+$/);
  expect(k1).toMatch(/^codex:transcript-delta:sess-x:\d+$/);
  expect(Number(k1.split(":").pop())).toBeGreaterThan(Number(k0.split(":").pop()));
  expect(Number(out.cursor)).toBeGreaterThan(0);

  // Re-reading from the advanced cursor yields nothing new.
  const again = normalizeCodex({
    point: "usage.reported", source: "transcript-delta",
    raw: { session_id: "sess-x", transcript_path: transcript }, cursor: out.cursor, target,
  });
  expect(again.events).toHaveLength(0);
});

test("usage.reported with a missing transcript path is a no-op", () => {
  expect(normalizeCodex({ point: "usage.reported", source: "transcript-delta", raw: { session_id: "x", transcript_path: "/no/such/file" }, cursor: null, target }).events).toHaveLength(0);
});
