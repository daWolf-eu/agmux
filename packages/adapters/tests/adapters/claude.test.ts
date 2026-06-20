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

test("input.required only fires for genuine blocks; idle is a no-op", () => {
  // permission dialog → waiting (permission)
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: { notification_type: "permission_prompt" }, target }).events[0]?.payload).toEqual({ kind: "permission" });
  // MCP elicitation (server requesting user input) → waiting (prompt)
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: { notification_type: "elicitation_dialog" }, target }).events[0]?.payload).toEqual({ kind: "prompt" });
  // idle_prompt = turn finished, awaiting the next message → NOT a block; no event (Stop→turn.ended governs "idle")
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: { notification_type: "idle_prompt" }, target }).events).toHaveLength(0);
  // auth/ack/unknown notification types → no event
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: { notification_type: "auth_success" }, target }).events).toHaveLength(0);
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
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

import { resolveConfigDir, skillsPluginDir, claudeInstall, claudeUninstall, claudeStatus, ADAPTER_VERSION } from "../../src/adapters/claude/install.ts";
import * as os from "node:os";
import * as fs from "node:fs";

function tmpCfg(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-claude-cfg-"));
}

const ictx = (configDir: string | undefined, profile: string | null = null, override: string | null = null) => ({
  agentKind: "claude" as const, profile,
  profileEnv: (configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) as Record<string, string>,
  agmuxEmitPath: "/abs/agmux emit", stateDir: "/tmp/state",
  ...(override ? { configDirOverride: override } : {}),
});

test("resolveConfigDir: explicit override > profileEnv CLAUDE_CONFIG_DIR > default ~/.claude", () => {
  expect(resolveConfigDir(ictx("/cfg"))).toBe("/cfg");
  expect(resolveConfigDir(ictx("/cfg", null, "/override"))).toBe("/override");
  expect(resolveConfigDir(ictx(undefined)).endsWith("/.claude")).toBe(true);
});

test("install writes the plugin into <configDir>/skills/agmux and flips status; uninstall reverses", () => {
  const cfg = tmpCfg();
  const ctx = ictx(cfg, "work");

  expect(claudeStatus(ctx).installed).toBe(false);
  const rec = claudeInstall(ctx);
  expect(rec).toMatchObject({ agentKind: "claude", profile: "work", adapterVersion: ADAPTER_VERSION, isolationMode: "config-dir" });

  // The skills-dir plugin is fully materialized: manifest, hooks, executable shim.
  const dest = skillsPluginDir(cfg);
  expect(fs.existsSync(path.join(dest, ".claude-plugin", "plugin.json"))).toBe(true);
  expect(fs.existsSync(path.join(dest, "hooks", "hooks.json"))).toBe(true);
  const shimMode = fs.statSync(path.join(dest, "bin", "agmux-emit")).mode & 0o111;
  expect(shimMode).not.toBe(0); // executable bit preserved
  expect(rec.artifacts.some((a) => a.kind === "file" && a.path === dest)).toBe(true);

  expect(claudeStatus(ctx)).toMatchObject({ installed: true, version: ADAPTER_VERSION, drift: false });

  claudeUninstall(ctx, rec);
  expect(fs.existsSync(dest)).toBe(false);
  expect(claudeStatus(ctx).installed).toBe(false);
});

test("install is idempotent (re-install refreshes the copy)", () => {
  const cfg = tmpCfg();
  const ctx = ictx(cfg);
  claudeInstall(ctx);
  const rec = claudeInstall(ctx);
  expect(claudeStatus(ctx).installed).toBe(true);
  claudeUninstall(ctx, rec);
});

test("status reports drift when the installed plugin.json version differs from the embedded payload", () => {
  const cfg = tmpCfg();
  const ctx = ictx(cfg);
  claudeInstall(ctx);
  const manifest = path.join(skillsPluginDir(cfg), ".claude-plugin", "plugin.json");
  const p = JSON.parse(fs.readFileSync(manifest, "utf8"));
  fs.writeFileSync(manifest, JSON.stringify({ ...p, version: "0.0.1-stale" }));
  expect(claudeStatus(ctx).drift).toBe(true);
});

test("separate config dirs install independently (profile isolation)", () => {
  const cfgA = tmpCfg();
  const cfgB = tmpCfg();
  claudeInstall(ictx(cfgA));
  expect(claudeStatus(ictx(cfgA)).installed).toBe(true);
  expect(claudeStatus(ictx(cfgB)).installed).toBe(false);
});

import { claudeAdapter } from "../../src/adapters/claude/index.ts";
import { assertAdapterConformance } from "../../src/core/conformance.ts";

test("the default claudeAdapter exposes the expected shape", () => {
  expect(claudeAdapter.agentKind).toBe("claude");
  expect(claudeAdapter.sources({} as any).length).toBe(2);
  expect(Object.keys(claudeAdapter.capabilities({} as any))).toContain("usage.reported");
});

test("claudeAdapter passes the framework conformance battery (real fs install)", () => {
  const cfg = tmpCfg();
  const passed = assertAdapterConformance(claudeAdapter, {
    makeContext: () => ({ agentKind: "claude", profile: null, profileEnv: { CLAUDE_CONFIG_DIR: cfg }, agmuxEmitPath: "/abs/agmux emit", stateDir: cfg }),
    makeResumeContext: (nid) => ({ agentKind: "claude", profile: null, command: "claude", args: [], cwd: "/work", env: {}, nativeSessionId: nid }),
  });
  expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan"]);
});

test("identity mismatch (nested claude run) drops all events", () => {
  // Under a wrapper CLAIM (AGMUX_SESSION_ID set), env CLAUDE_CODE_SESSION_ID is the
  // OUTER claude's while stdin session_id is the nested one's — leaked claim, drop all.
  const out = normalizeClaude({
    point: "session.linked", source: "hook-command",
    raw: { session_id: "nested-xyz" }, target,
    env: { AGMUX_SESSION_ID: "claimed", CLAUDE_CODE_SESSION_ID: "outer-abc" },
  });
  expect(out.events).toHaveLength(0);
});

test("identity match or absent env keeps events flowing", () => {
  const match = normalizeClaude({
    point: "session.linked", source: "hook-command",
    raw: { session_id: "sess-abc" }, target,
    env: { CLAUDE_CODE_SESSION_ID: "sess-abc" },
  });
  expect(match.events).toHaveLength(1);
  const absent = normalizeClaude({
    point: "turn.started", source: "hook-command", raw: { session_id: "sess-abc" }, target,
  });
  expect(absent.events).toHaveLength(1);
});

test("claude normalize(session.registered) builds the native lifecycle root from stdin + env", () => {
  const out = claudeAdapter.normalize({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-9", cwd: "/work" },
    target: { agentKind: "claude", profile: null },
    env: { AGMUX_AGENT_PID: "5151", TMUX_PANE: "%4", AGMUX_PROFILE: "work", CLAUDE_CODE_SESSION_ID: "nat-9" },
  });
  expect(out.events).toHaveLength(1);
  const ev = out.events[0]!;
  const p = ev.payload as any;
  expect(ev.kind).toBe("session.registered");
  expect(p.native_session_id).toBe("nat-9");
  expect(p.agent_kind).toBe("claude");
  expect(p.pid).toBe(5151);
  expect(p.cwd).toBe("/work");
  expect(p.tmux_pane).toBe("%4");
  expect(p.profile).toBe("work");
  expect(p.parent).toBeNull();
});

test("claude normalize(session.registered) stores null pid when AGMUX_AGENT_PID is absent/garbage", () => {
  const out = claudeAdapter.normalize({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-x" }, target: { agentKind: "claude", profile: null },
    env: { CLAUDE_CODE_SESSION_ID: "nat-x", AGMUX_AGENT_PID: "notanum" },
  });
  expect((out.events[0]!.payload as any).pid).toBeNull();
});

test("claude nativeIdFromEnv reads CLAUDE_CODE_SESSION_ID", () => {
  expect(claudeAdapter.nativeIdFromEnv!({ CLAUDE_CODE_SESSION_ID: "abc" })).toBe("abc");
  expect(claudeAdapter.nativeIdFromEnv!({})).toBeNull();
});

test("compaction maps PreCompact trigger; defaults to null when absent", () => {
  expect(normalizeClaude({ point: "compaction", source: "hook-command", raw: { trigger: "manual" }, target }).events[0])
    .toEqual({ kind: "compaction", payload: { trigger: "manual" } });
  expect(normalizeClaude({ point: "compaction", source: "hook-command", raw: { trigger: "auto" }, target }).events[0]?.payload)
    .toEqual({ trigger: "auto" });
  expect(normalizeClaude({ point: "compaction", source: "hook-command", raw: {}, target }).events[0]?.payload)
    .toEqual({ trigger: null });
  // unrecognized trigger values coerce to null (guards against loosening the check)
  expect(normalizeClaude({ point: "compaction", source: "hook-command", raw: { trigger: "bogus" }, target }).events[0]?.payload)
    .toEqual({ trigger: null });
});

test("tool.used reflects tool_response failure: is_error/success:false → fail, else ok", () => {
  const err = normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash", tool_response: { is_error: true } }, target });
  expect(err.events[0]?.payload).toEqual({ tool: "Bash", ok: false, detail: "error" });

  const failSuccessFalse = normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Read", tool_response: { success: false } }, target });
  expect(failSuccessFalse.events[0]?.payload).toEqual({ tool: "Read", ok: false, detail: "error" });

  // No failure signal → default ok (unchanged behavior).
  const ok = normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash", tool_response: { stdout: "hi" } }, target });
  expect(ok.events[0]?.payload).toEqual({ tool: "Bash", ok: true });

  // No tool_response at all → default ok.
  const bare = normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash" }, target });
  expect(bare.events[0]?.payload).toEqual({ tool: "Bash", ok: true });
});
