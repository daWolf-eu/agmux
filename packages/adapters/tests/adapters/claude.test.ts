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

import { normalizeClaude } from "../../src/adapters/claude/normalize.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude");
const transcript = path.join(FX, "transcript.sample.jsonl");
const target = { agentKind: "claude" as const, profile: null };

test("session.linked maps native session id from stdin", () => {
  const out = normalizeClaude({ point: "session.linked", source: "hook-command", raw: { session_id: "sess-abc" }, target });
  expect(out.events).toEqual([{ kind: "session.linked", payload: { native_session_id: "sess-abc" } }]);
});

test("turn.started / turn.ended map to canonical events", () => {
  expect(normalizeClaude({ point: "turn.started", source: "hook-command", raw: {}, target }).events[0]?.kind).toBe("turn.started");
  const ended = normalizeClaude({ point: "turn.ended", source: "hook-command", raw: { reason: "end_turn" }, target });
  expect(ended.events[0]).toEqual({ kind: "turn.ended", payload: { reason: "end_turn" } });
});

test("input.required distinguishes permission vs prompt", () => {
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: { notification_type: "permission_prompt" }, target }).events[0]?.payload).toEqual({ kind: "permission" });
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: { notification_type: "idle" }, target }).events[0]?.payload).toEqual({ kind: "prompt" });
});

test("prompt.sent is redacted (chars only); tool.used carries the tool name", () => {
  expect(normalizeClaude({ point: "prompt.sent", source: "hook-command", raw: { prompt: "hello" }, target }).events[0]?.payload).toEqual({ chars: 5, redacted: true });
  expect(normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash" }, target }).events[0]?.payload).toEqual({ tool: "Bash", ok: true });
});

test("usage.reported reads transcript deltas with stable dedup keys and advances the cursor", () => {
  const out = normalizeClaude({ point: "usage.reported", source: "transcript-delta", raw: { session_id: "sess-abc", transcript_path: transcript }, cursor: null, target });
  expect(out.events).toHaveLength(2); // two assistant records, user line skipped
  expect(out.events[0]).toMatchObject({
    kind: "usage.reported",
    payload: { cumulative: false, source: "transcript-delta", model: "claude-opus-4-8", input_tokens: 8565, output_tokens: 218, cache_read_tokens: 16672, cache_write_tokens: 2940, turn_id: "msg_1" },
    dedup_key: "claude:transcript-delta:sess-abc:a-1",
  });
  expect(out.events[1]?.dedup_key).toBe("claude:transcript-delta:sess-abc:a-2");
  expect(Number(out.cursor)).toBeGreaterThan(0);

  // Re-reading from the advanced cursor yields nothing new (dedup at the source).
  const again = normalizeClaude({ point: "usage.reported", source: "transcript-delta", raw: { session_id: "sess-abc", transcript_path: transcript }, cursor: out.cursor, target });
  expect(again.events).toHaveLength(0);
});

test("usage.reported with a missing transcript path is a no-op", () => {
  expect(normalizeClaude({ point: "usage.reported", source: "transcript-delta", raw: { session_id: "x", transcript_path: "/no/such/file" }, cursor: null, target }).events).toHaveLength(0);
});

import { claudeResumePlan } from "../../src/adapters/claude/resume.ts";

const resumeCtx = (nid: string | null) => ({
  agentKind: "claude" as const, profile: null, command: "claude", args: ["--model", "opus"],
  cwd: "/work", env: { FOO: "1" }, nativeSessionId: nid,
});

test("resumePlan builds `claude --resume <id>` preserving original args", () => {
  const plan = claudeResumePlan(resumeCtx("sess-abc"));
  expect(plan.resumable).toBe(true);
  expect(plan.argv).toEqual(["claude", "--resume", "sess-abc", "--model", "opus"]);
  expect(plan.cwd).toBe("/work");
  expect(plan.nativeSessionId).toBe("sess-abc");
});

test("resumePlan is not resumable without a native session id", () => {
  expect(claudeResumePlan(resumeCtx(null))).toEqual({ resumable: false });
});
