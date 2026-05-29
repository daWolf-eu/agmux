# Claude Code Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first concrete provider on the adapter framework — a Claude Code `Adapter` that links the native session id, drives `running`/`idle`/`waiting`, accumulates token usage from the transcript, installs via Claude's official plugin mechanism, and resumes natively — passing the framework conformance gate.

**Architecture:** A self-contained `packages/adapters/src/adapters/claude/` module implementing the existing `Adapter` interface, split into focused files (`caps`, `normalize`, `resume`, `runner`, `install`, `index`) plus a static in-repo Claude plugin/marketplace. Install/uninstall/status are driven through the official `/plugin` slash commands (run headlessly, scoped by `CLAUDE_CONFIG_DIR`) behind an **injectable `PluginRunner`** so the module is unit-testable without a live Claude. The module imports only `../../core/*` and is wired in with one `register()` line.

**Tech Stack:** TypeScript on Bun, `bun test`, `node:child_process` (`spawnSync`) for the official plugin CLI, `node:fs` for transcript reads. No new package; no hub/store/protocol/CLI changes.

**Spec:** [`docs/superpowers/specs/2026-05-29-adapter-claude-design.md`](../specs/2026-05-29-adapter-claude-design.md).

**Framework contract (landed, do not modify):** `Adapter` and supporting types in `packages/adapters/src/core/types.ts`; the conformance harness `assertAdapterConformance(adapter, { makeContext, makeResumeContext })` in `packages/adapters/src/core/conformance.ts`; the registry seam `registerAll(registry)` in `packages/adapters/src/adapters/index.ts`; `agmux emit` calls `adapter.normalize({ point, source, raw: <parsed stdin>, cursor, target })` and persists the returned `cursor` to the `--cursor-file`.

**Out of scope:** any framework change; continuous source modes; the deferred reconciliation daemon; cost/pricing. The `prompt.sent`/`tool.used` log-only points ship (cheap), per spec §10.

---

## File Structure

**New module `packages/adapters/src/adapters/claude/`** (imports only `../../core/*`):
- `caps.ts` — `CLAUDE_SOURCES` + `CLAUDE_CAPABILITIES` (pure data).
- `normalize.ts` — `normalizeClaude(input)`: maps each hook point to canonical events; reads the transcript for `usage.reported`.
- `resume.ts` — `claudeResumePlan(ctx)`.
- `runner.ts` — `PluginRunner` interface + `claudePluginRunner(claudeBin, spawn)` (official `/plugin` driver, injectable spawner).
- `install.ts` — `resolveConfigDir`, `claudeInstall`/`claudeUninstall`/`claudeStatus`, `PLUGIN_REF`, `ADAPTER_VERSION`.
- `index.ts` — `createClaudeAdapter(deps)` + the default `claudeAdapter`.
- `marketplace/.claude-plugin/marketplace.json` — static local marketplace.
- `marketplace/plugins/agmux/.claude-plugin/plugin.json` — plugin manifest.
- `marketplace/plugins/agmux/hooks/hooks.json` — hook wiring → `agmux emit`.
- `marketplace/plugins/agmux/bin/agmux-emit` — shim: `exec "${AGMUX_BIN:-agmux}" emit "$@"`.

**Test fixtures `packages/adapters/tests/adapters/`:**
- `fixtures/fake-plugin-runner.ts` — in-memory `PluginRunner` for tests.
- `fixtures/claude/transcript.sample.jsonl` — real-shape transcript lines (assistant usage).
- `fixtures/claude/hook-stdin.sample.json` — example hook stdin payloads.
- `claude.test.ts` — caps, normalize (all points), resume, runner, install, conformance.

**Modified:**
- `packages/adapters/src/adapters/index.ts` — `register(claudeAdapter)`.
- `packages/wrapper/src/index.ts` — forward `AGMUX_BIN` through the tmux re-exec env list.

---

## Task 1: Claude capabilities + source set

**Files:**
- Create: `packages/adapters/src/adapters/claude/caps.ts`
- Test: `packages/adapters/tests/adapters/claude.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/tests/adapters/claude.test.ts`:

```typescript
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
  expect(CLAUDE_CAPABILITIES["input.required"].fulfil).toBe("partial");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: FAIL — `caps.ts` does not exist.

- [ ] **Step 3: Implement**

Create `packages/adapters/src/adapters/claude/caps.ts`:

```typescript
import type { CapabilityMap } from "@agmux/protocol";
import type { CapabilitySource } from "../../core/types.ts";

// Two event-triggered sources (spec §3). hook-command drives the state machine +
// optional log-only points; transcript-delta carries usage (the only stateful read).
export const CLAUDE_SOURCES: CapabilitySource[] = [
  {
    type: "hook-command",
    activation: "event-triggered",
    points: ["session.linked", "turn.started", "turn.ended", "input.required", "tool.used", "prompt.sent"],
  },
  {
    type: "transcript-delta",
    activation: "event-triggered",
    points: ["usage.reported"],
  },
];

// Finest-grain descriptors (spec §4). input.required is "partial" — Claude's
// Notification hook is coarse (permission AND idle). input.received is omitted:
// it is fulfilled implicitly by the next turn.started, never emitted.
export const CLAUDE_CAPABILITIES: CapabilityMap = {
  "session.linked": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.ended": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "input.required": { fulfil: "partial", source: "hook-command", liveness: "live" },
  "usage.reported": { fulfil: "yes", source: "transcript-delta", liveness: "backfilled" },
  "tool.used": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "prompt.sent": { fulfil: "yes", source: "hook-command", liveness: "live" },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/claude/caps.ts packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters/claude: capabilities and source set"
```

---

## Task 2: Normalization — all hook points + transcript-delta usage

**Files:**
- Create: `packages/adapters/src/adapters/claude/normalize.ts`
- Create: `packages/adapters/tests/adapters/fixtures/claude/transcript.sample.jsonl`
- Create: `packages/adapters/tests/adapters/fixtures/claude/hook-stdin.sample.json`
- Test: `packages/adapters/tests/adapters/claude.test.ts` (append)

- [ ] **Step 1: Create the fixtures (real-shape captured data)**

Create `packages/adapters/tests/adapters/fixtures/claude/transcript.sample.jsonl` (three lines — a user line, then two assistant records with the real Claude usage shape; keep each as one line):

```
{"type":"user","uuid":"u-1","sessionId":"sess-abc","timestamp":"2026-05-29T10:00:00.000Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"a-1","sessionId":"sess-abc","timestamp":"2026-05-29T10:00:05.000Z","message":{"id":"msg_1","model":"claude-opus-4-8","role":"assistant","usage":{"input_tokens":8565,"output_tokens":218,"cache_read_input_tokens":16672,"cache_creation_input_tokens":2940}}}
{"type":"assistant","uuid":"a-2","sessionId":"sess-abc","timestamp":"2026-05-29T10:00:09.000Z","message":{"id":"msg_2","model":"claude-opus-4-8","role":"assistant","usage":{"input_tokens":40,"output_tokens":12,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

Create `packages/adapters/tests/adapters/fixtures/claude/hook-stdin.sample.json` (representative hook stdin payloads; the common fields `session_id`/`transcript_path`/`cwd`/`hook_event_name` are always present):

```json
{
  "SessionStart": { "session_id": "sess-abc", "transcript_path": "/tmp/t.jsonl", "cwd": "/work", "hook_event_name": "SessionStart", "source": "startup" },
  "UserPromptSubmit": { "session_id": "sess-abc", "transcript_path": "/tmp/t.jsonl", "cwd": "/work", "hook_event_name": "UserPromptSubmit", "prompt": "hello world" },
  "Stop": { "session_id": "sess-abc", "transcript_path": "/tmp/t.jsonl", "cwd": "/work", "hook_event_name": "Stop" },
  "Notification": { "session_id": "sess-abc", "transcript_path": "/tmp/t.jsonl", "cwd": "/work", "hook_event_name": "Notification", "notification_type": "permission_prompt" },
  "PostToolUse": { "session_id": "sess-abc", "transcript_path": "/tmp/t.jsonl", "cwd": "/work", "hook_event_name": "PostToolUse", "tool_name": "Bash" }
}
```

- [ ] **Step 2: Write the failing tests (append to `claude.test.ts`)**

```typescript
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
  expect(normalizeClaude({ point: "turn.started", source: "hook-command", raw: {}, target }).events[0].kind).toBe("turn.started");
  const ended = normalizeClaude({ point: "turn.ended", source: "hook-command", raw: { reason: "end_turn" }, target });
  expect(ended.events[0]).toEqual({ kind: "turn.ended", payload: { reason: "end_turn" } });
});

test("input.required distinguishes permission vs prompt", () => {
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: { notification_type: "permission_prompt" }, target }).events[0].payload).toEqual({ kind: "permission" });
  expect(normalizeClaude({ point: "input.required", source: "hook-command", raw: { notification_type: "idle" }, target }).events[0].payload).toEqual({ kind: "prompt" });
});

test("prompt.sent is redacted (chars only); tool.used carries the tool name", () => {
  expect(normalizeClaude({ point: "prompt.sent", source: "hook-command", raw: { prompt: "hello" }, target }).events[0].payload).toEqual({ chars: 5, redacted: true });
  expect(normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash" }, target }).events[0].payload).toEqual({ tool: "Bash", ok: true });
});

test("usage.reported reads transcript deltas with stable dedup keys and advances the cursor", () => {
  const out = normalizeClaude({ point: "usage.reported", source: "transcript-delta", raw: { session_id: "sess-abc", transcript_path: transcript }, cursor: null, target });
  expect(out.events).toHaveLength(2); // two assistant records, user line skipped
  expect(out.events[0]).toMatchObject({
    kind: "usage.reported",
    payload: { cumulative: false, source: "transcript-delta", model: "claude-opus-4-8", input_tokens: 8565, output_tokens: 218, cache_read_tokens: 16672, cache_write_tokens: 2940, turn_id: "msg_1" },
    dedup_key: "claude:transcript-delta:sess-abc:a-1",
  });
  expect(out.events[1].dedup_key).toBe("claude:transcript-delta:sess-abc:a-2");
  expect(Number(out.cursor)).toBeGreaterThan(0);

  // Re-reading from the advanced cursor yields nothing new (dedup at the source).
  const again = normalizeClaude({ point: "usage.reported", source: "transcript-delta", raw: { session_id: "sess-abc", transcript_path: transcript }, cursor: out.cursor, target });
  expect(again.events).toHaveLength(0);
});

test("usage.reported with a missing transcript path is a no-op", () => {
  expect(normalizeClaude({ point: "usage.reported", source: "transcript-delta", raw: { session_id: "x", transcript_path: "/no/such/file" }, cursor: null, target }).events).toHaveLength(0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: FAIL — `normalize.ts` does not exist.

- [ ] **Step 4: Implement**

Create `packages/adapters/src/adapters/claude/normalize.ts`:

```typescript
import * as fs from "node:fs";
import type { NormalizeInput, NormalizeOutput, CanonicalEvent } from "../../core/types.ts";

interface ClaudeHookStdin {
  session_id?: string;
  transcript_path?: string;
  prompt?: string;
  tool_name?: string;
  notification_type?: string;
  reason?: string;
}

export function normalizeClaude(input: NormalizeInput): NormalizeOutput {
  const raw = (input.raw ?? {}) as ClaudeHookStdin & Record<string, unknown>;
  switch (input.point) {
    case "session.linked":
      if (!raw.session_id) return { events: [] };
      return { events: [{ kind: "session.linked", payload: { native_session_id: raw.session_id } }] };
    case "turn.started":
      return { events: [{ kind: "turn.started", payload: {} }] };
    case "turn.ended":
      return { events: [{ kind: "turn.ended", payload: { reason: raw.reason ?? null } }] };
    case "input.required": {
      const kind = raw.notification_type === "permission_prompt" ? "permission" : "prompt";
      return { events: [{ kind: "input.required", payload: { kind } }] };
    }
    case "prompt.sent":
      return { events: [{ kind: "prompt.sent", payload: { chars: typeof raw.prompt === "string" ? raw.prompt.length : null, redacted: true } }] };
    case "tool.used":
      return { events: [{ kind: "tool.used", payload: { tool: typeof raw.tool_name === "string" ? raw.tool_name : "unknown", ok: true } }] };
    case "usage.reported":
      return normalizeUsage(input, raw);
    default:
      return { events: [] };
  }
}

// Read NEW assistant records from the transcript since the byte cursor. Each
// carries a per-turn usage delta; rec.uuid makes the dedup key stable so a
// re-read (duplicate Stop, resume re-scan) never double-counts (spec §5).
function normalizeUsage(input: NormalizeInput, raw: ClaudeHookStdin): NormalizeOutput {
  const transcriptPath = raw.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { events: [] };

  const start = input.cursor ? Number(input.cursor) : 0;
  const size = fs.statSync(transcriptPath).size;
  if (!Number.isFinite(start) || start < 0 || start >= size) return { events: [], cursor: String(size) };

  const buf = fs.readFileSync(transcriptPath);
  const slice = buf.subarray(start).toString("utf8");
  // Only consume whole lines; leave a trailing partial line for the next read.
  const lastNl = slice.lastIndexOf("\n");
  const consumable = lastNl < 0 ? "" : slice.slice(0, lastNl + 1);
  const newCursor = start + Buffer.byteLength(consumable, "utf8");

  const nativeId = raw.session_id ?? "unknown";
  const events: CanonicalEvent[] = [];
  for (const line of consumable.split("\n")) {
    if (line.trim() === "") continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== "assistant") continue;
    const u = rec.message?.usage;
    if (!u) continue;
    events.push({
      kind: "usage.reported",
      payload: {
        cumulative: false,
        source: "transcript-delta",
        model: rec.message?.model ?? null,
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cache_read_tokens: u.cache_read_input_tokens ?? null,
        cache_write_tokens: u.cache_creation_input_tokens ?? null,
        turn_id: rec.message?.id ?? null,
        as_of: rec.timestamp ?? null,
      },
      dedup_key: `claude:transcript-delta:${nativeId}:${rec.uuid}`,
    });
  }
  return { events, cursor: String(newCursor) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/adapters/claude/normalize.ts packages/adapters/tests/adapters/fixtures/claude/ packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters/claude: normalize hook points + transcript-delta usage"
```

---

## Task 3: Resume plan

**Files:**
- Create: `packages/adapters/src/adapters/claude/resume.ts`
- Test: `packages/adapters/tests/adapters/claude.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: FAIL — `resume.ts` does not exist.

- [ ] **Step 3: Implement**

Create `packages/adapters/src/adapters/claude/resume.ts`:

```typescript
import type { ResumeContext, ResumePlan } from "../../core/types.ts";

// `claude --resume <id>` reuses the same session id and replays the conversation
// (spec §1, verified). Without a native id, fall back to a fresh relaunch.
export function claudeResumePlan(ctx: ResumeContext): ResumePlan {
  if (!ctx.nativeSessionId) return { resumable: false };
  return {
    resumable: true,
    argv: [ctx.command, "--resume", ctx.nativeSessionId, ...ctx.args],
    cwd: ctx.cwd,
    env: ctx.env,
    nativeSessionId: ctx.nativeSessionId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/claude/resume.ts packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters/claude: native resume plan"
```

---

## Task 4: Plugin runner (official `/plugin` driver, injectable spawner)

**Files:**
- Create: `packages/adapters/src/adapters/claude/runner.ts`
- Test: `packages/adapters/tests/adapters/claude.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

```typescript
import { claudePluginRunner, type Spawner } from "../../src/adapters/claude/runner.ts";

function recordingSpawner(out = "[]") {
  const calls: { args: string[]; configDir: string }[] = [];
  const spawn: Spawner = (_bin, args, configDir) => { calls.push({ args, configDir }); return { code: 0, out }; };
  return { calls, spawn };
}

test("runner issues the official /plugin commands scoped to the config dir", () => {
  const { calls, spawn } = recordingSpawner();
  const r = claudePluginRunner("claude", spawn);
  r.marketplaceAdd("/cfg", "/repo/marketplace");
  r.install("/cfg", "agmux@agmux");
  r.uninstall("/cfg", "agmux@agmux");
  expect(calls.map((c) => c.args.join(" "))).toEqual([
    "-p /plugin marketplace add /repo/marketplace",
    "-p /plugin install agmux@agmux",
    "-p /plugin uninstall agmux@agmux",
  ]);
  expect(calls.every((c) => c.configDir === "/cfg")).toBe(true);
});

test("isInstalled parses the /plugin list --json output", () => {
  const installed = recordingSpawner(JSON.stringify([{ name: "agmux", marketplace: "agmux", enabled: true }]));
  expect(claudePluginRunner("claude", installed.spawn).isInstalled("/cfg", "agmux@agmux")).toBe(true);
  const empty = recordingSpawner("[]");
  expect(claudePluginRunner("claude", empty.spawn).isInstalled("/cfg", "agmux@agmux")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: FAIL — `runner.ts` does not exist.

- [ ] **Step 3: Implement**

Create `packages/adapters/src/adapters/claude/runner.ts`:

```typescript
import { spawnSync } from "node:child_process";

// The official plugin surface is the `/plugin` slash command, driven headlessly
// via `claude -p "..."` and scoped by CLAUDE_CONFIG_DIR (spec §2). No standalone
// `claude plugin` CLI exists. The spawner is injectable so the command wiring is
// unit-testable without a live Claude.
export type Spawner = (bin: string, args: string[], configDir: string) => { code: number; out: string };

export interface PluginRunner {
  marketplaceAdd(configDir: string, marketplacePath: string): void;
  install(configDir: string, pluginRef: string): void;
  uninstall(configDir: string, pluginRef: string): void;
  isInstalled(configDir: string, pluginRef: string): boolean;
}

const defaultSpawn: Spawner = (bin, args, configDir) => {
  const r = spawnSync(bin, args, { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

export function claudePluginRunner(claudeBin = "claude", spawn: Spawner = defaultSpawn): PluginRunner {
  const slash = (configDir: string, command: string) => spawn(claudeBin, ["-p", command], configDir);
  return {
    marketplaceAdd(configDir, marketplacePath) { slash(configDir, `/plugin marketplace add ${marketplacePath}`); },
    install(configDir, ref) { slash(configDir, `/plugin install ${ref}`); },
    uninstall(configDir, ref) { slash(configDir, `/plugin uninstall ${ref}`); },
    isInstalled(configDir, ref) {
      const { out } = slash(configDir, `/plugin list --json`);
      try {
        const list = JSON.parse(out);
        return Array.isArray(list) && list.some((p: any) => `${p.name}@${p.marketplace}` === ref && p.enabled !== false);
      } catch {
        return out.includes(ref); // read-only fallback if --json is unavailable (spec §7.2)
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/claude/runner.ts packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters/claude: official /plugin runner with injectable spawner"
```

---

## Task 5: Install / uninstall / status

**Files:**
- Create: `packages/adapters/src/adapters/claude/install.ts`
- Create: `packages/adapters/tests/adapters/fixtures/fake-plugin-runner.ts`
- Test: `packages/adapters/tests/adapters/claude.test.ts` (append)

- [ ] **Step 1: Create the fake runner fixture**

Create `packages/adapters/tests/adapters/fixtures/fake-plugin-runner.ts`:

```typescript
import type { PluginRunner } from "../../../src/adapters/claude/runner.ts";

// In-memory PluginRunner: install state keyed by (configDir, pluginRef). Lets the
// adapter's install/status/uninstall (and the conformance roundtrip) run without a
// live Claude.
export function fakePluginRunner(): PluginRunner {
  const installed = new Set<string>();
  const key = (configDir: string, ref: string) => `${configDir}::${ref}`;
  return {
    marketplaceAdd() {},
    install(configDir, ref) { installed.add(key(configDir, ref)); },
    uninstall(configDir, ref) { installed.delete(key(configDir, ref)); },
    isInstalled(configDir, ref) { return installed.has(key(configDir, ref)); },
  };
}
```

- [ ] **Step 2: Write the failing test (append)**

```typescript
import { resolveConfigDir, claudeInstall, claudeUninstall, claudeStatus, PLUGIN_REF, ADAPTER_VERSION } from "../../src/adapters/claude/install.ts";
import { fakePluginRunner } from "./fixtures/fake-plugin-runner.ts";

const ictx = (configDir: string | undefined, profile: string | null = null) => ({
  agentKind: "claude" as const, profile,
  profileEnv: configDir ? { CLAUDE_CONFIG_DIR: configDir } : {},
  agmuxEmitPath: "/abs/agmux emit", stateDir: "/tmp/state",
});

test("resolveConfigDir prefers CLAUDE_CONFIG_DIR from profileEnv, else default ~/.claude", () => {
  expect(resolveConfigDir(ictx("/cfg"))).toBe("/cfg");
  expect(resolveConfigDir(ictx(undefined)).endsWith("/.claude")).toBe(true);
});

test("install records the plugin + marketplace artifacts and flips status", () => {
  const runner = fakePluginRunner();
  const ctx = ictx("/cfg", "work");
  const rec = claudeInstall(ctx, runner, "/repo/marketplace");
  expect(rec).toMatchObject({ agentKind: "claude", profile: "work", adapterVersion: ADAPTER_VERSION, isolationMode: "config-dir" });
  expect(rec.artifacts.some((a) => a.detail === `plugin ${PLUGIN_REF}`)).toBe(true);
  expect(claudeStatus(ctx, runner)).toMatchObject({ installed: true, version: ADAPTER_VERSION, runtimeGate: "hook-trust" });

  claudeUninstall(ctx, runner);
  expect(claudeStatus(ctx, runner).installed).toBe(false);
});

test("separate config dirs install independently (profile isolation)", () => {
  const runner = fakePluginRunner();
  claudeInstall(ictx("/cfg-a"), runner, "/m");
  expect(claudeStatus(ictx("/cfg-a"), runner).installed).toBe(true);
  expect(claudeStatus(ictx("/cfg-b"), runner).installed).toBe(false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: FAIL — `install.ts` does not exist.

- [ ] **Step 4: Implement**

Create `packages/adapters/src/adapters/claude/install.ts`:

```typescript
import * as os from "node:os";
import * as path from "node:path";
import type { InstallContext, InstallRecord, InstallStatus } from "../../core/types.ts";
import type { PluginRunner } from "./runner.ts";
import { CLAUDE_CAPABILITIES } from "./caps.ts";

export const PLUGIN_REF = "agmux@agmux";
export const ADAPTER_VERSION = "1";

// config-dir isolation (spec §6): the profile resolves to its own CLAUDE_CONFIG_DIR;
// the bare target uses the default. All install state lives under this dir.
export function resolveConfigDir(ctx: InstallContext): string {
  return ctx.profileEnv.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function claudeInstall(ctx: InstallContext, runner: PluginRunner, marketplacePath: string): InstallRecord {
  const configDir = resolveConfigDir(ctx);
  runner.marketplaceAdd(configDir, marketplacePath);
  runner.install(configDir, PLUGIN_REF);
  const settings = path.join(configDir, "settings.json");
  return {
    agentKind: "claude",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: CLAUDE_CAPABILITIES,
    artifacts: [
      { kind: "config-key", path: settings, detail: `plugin ${PLUGIN_REF}`, restore: null },
      { kind: "config-key", path: settings, detail: "marketplace agmux", restore: null },
    ],
  };
}

export function claudeUninstall(ctx: InstallContext, runner: PluginRunner): void {
  runner.uninstall(resolveConfigDir(ctx), PLUGIN_REF);
}

export function claudeStatus(ctx: InstallContext, runner: PluginRunner): InstallStatus {
  const installed = runner.isInstalled(resolveConfigDir(ctx), PLUGIN_REF);
  // Plugin trust may gate hook activation even when installed+enabled (spec §7.1).
  return { installed, version: installed ? ADAPTER_VERSION : null, drift: false, runtimeGate: "hook-trust" };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/adapters/claude/install.ts packages/adapters/tests/adapters/fixtures/fake-plugin-runner.ts packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters/claude: install/uninstall/status via plugin runner (config-dir isolation)"
```

---

## Task 6: Assemble the adapter + conformance gate

**Files:**
- Create: `packages/adapters/src/adapters/claude/index.ts`
- Test: `packages/adapters/tests/adapters/claude.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

```typescript
import { createClaudeAdapter, claudeAdapter } from "../../src/adapters/claude/index.ts";
import { assertAdapterConformance } from "../../src/core/conformance.ts";
import * as os from "node:os";
import * as fs from "node:fs";

test("the default claudeAdapter exposes the expected shape", () => {
  expect(claudeAdapter.agentKind).toBe("claude");
  expect(claudeAdapter.sources({} as any).length).toBe(2);
  expect(Object.keys(claudeAdapter.capabilities({} as any))).toContain("usage.reported");
});

test("createClaudeAdapter passes the framework conformance battery (with a fake runner)", () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-claude-conf-"));
  const adapter = createClaudeAdapter({ runner: fakePluginRunner(), marketplacePath: "/repo/marketplace" });
  const passed = assertAdapterConformance(adapter, {
    makeContext: () => ({ agentKind: "claude", profile: null, profileEnv: { CLAUDE_CONFIG_DIR: cfg }, agmuxEmitPath: "/abs/agmux emit", stateDir: cfg }),
    makeResumeContext: (nid) => ({ agentKind: "claude", profile: null, command: "claude", args: [], cwd: "/work", env: {}, nativeSessionId: nid }),
  });
  expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: FAIL — `index.ts` does not exist.

- [ ] **Step 3: Implement**

Create `packages/adapters/src/adapters/claude/index.ts`:

```typescript
import * as path from "node:path";
import type { Adapter } from "../../core/types.ts";
import { CLAUDE_SOURCES, CLAUDE_CAPABILITIES } from "./caps.ts";
import { normalizeClaude } from "./normalize.ts";
import { claudeResumePlan } from "./resume.ts";
import { claudePluginRunner, type PluginRunner } from "./runner.ts";
import { claudeInstall, claudeUninstall, claudeStatus, ADAPTER_VERSION } from "./install.ts";

export interface ClaudeAdapterDeps {
  runner?: PluginRunner;        // injected in tests; defaults to the real /plugin driver
  marketplacePath?: string;     // defaults to the static in-repo marketplace beside this module
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): Adapter {
  const runner = deps.runner ?? claudePluginRunner();
  const marketplacePath = deps.marketplacePath ?? path.join(import.meta.dir, "marketplace");
  return {
    agentKind: "claude",
    adapterVersion: ADAPTER_VERSION,
    sources: () => CLAUDE_SOURCES,
    capabilities: () => CLAUDE_CAPABILITIES,
    install: (ctx) => claudeInstall(ctx, runner, marketplacePath),
    uninstall: (ctx) => claudeUninstall(ctx, runner),
    status: (ctx) => claudeStatus(ctx, runner),
    normalize: normalizeClaude,
    resumePlan: claudeResumePlan,
  };
}

export const claudeAdapter: Adapter = createClaudeAdapter();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the package**

Run: `bun run --filter @agmux/adapters typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/adapters/claude/index.ts packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters/claude: assemble adapter; passes conformance"
```

---

## Task 7: Static Claude plugin + local marketplace

**Files:**
- Create: `packages/adapters/src/adapters/claude/marketplace/.claude-plugin/marketplace.json`
- Create: `packages/adapters/src/adapters/claude/marketplace/plugins/agmux/.claude-plugin/plugin.json`
- Create: `packages/adapters/src/adapters/claude/marketplace/plugins/agmux/hooks/hooks.json`
- Create: `packages/adapters/src/adapters/claude/marketplace/plugins/agmux/bin/agmux-emit`
- Test: `packages/adapters/tests/adapters/claude-plugin.test.ts`

- [ ] **Step 1: Write the failing structural test**

Create `packages/adapters/tests/adapters/claude-plugin.test.ts`:

```typescript
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "adapters", "claude", "marketplace");

test("marketplace.json declares the local agmux plugin", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  expect(m.name).toBe("agmux");
  expect(m.plugins[0]).toMatchObject({ name: "agmux", source: { source: "local", path: "./plugins/agmux" } });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude-plugin.test.ts`
Expected: FAIL — the marketplace files do not exist.

- [ ] **Step 3: Create the marketplace manifest**

`packages/adapters/src/adapters/claude/marketplace/.claude-plugin/marketplace.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "agmux",
  "owner": { "name": "agmux" },
  "plugins": [
    {
      "name": "agmux",
      "description": "agmux session telemetry integration",
      "source": { "source": "local", "path": "./plugins/agmux" }
    }
  ]
}
```

- [ ] **Step 4: Create the plugin manifest**

`packages/adapters/src/adapters/claude/marketplace/plugins/agmux/.claude-plugin/plugin.json`:

```json
{
  "name": "agmux",
  "description": "agmux session telemetry integration",
  "version": "1.0.0"
}
```

- [ ] **Step 5: Create the hook wiring**

`packages/adapters/src/adapters/claude/marketplace/plugins/agmux/hooks/hooks.json` (commands run via shell, so `${AGMUX_BIN:-agmux}` and `$HOME`/`$AGMUX_SESSION_ID` expand; all `async` so they never delay Claude):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "async": true, "command": "${AGMUX_BIN:-agmux} emit --from=claude --source=hook-command --point=session.linked" },
          { "type": "command", "async": true, "command": "${AGMUX_BIN:-agmux} emit --from=claude --attach" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "async": true, "command": "${AGMUX_BIN:-agmux} emit --from=claude --source=hook-command --point=turn.started" },
          { "type": "command", "async": true, "command": "${AGMUX_BIN:-agmux} emit --from=claude --source=hook-command --point=prompt.sent" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "async": true, "command": "${AGMUX_BIN:-agmux} emit --from=claude --source=hook-command --point=turn.ended" },
          { "type": "command", "async": true, "command": "${AGMUX_BIN:-agmux} emit --from=claude --source=transcript-delta --point=usage.reported --cursor-file=\"$HOME/.agmux/cursors/claude-$AGMUX_SESSION_ID.cursor\"" }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          { "type": "command", "async": true, "command": "${AGMUX_BIN:-agmux} emit --from=claude --source=hook-command --point=input.required" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "async": true, "command": "${AGMUX_BIN:-agmux} emit --from=claude --source=hook-command --point=tool.used" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Create the emit shim**

`packages/adapters/src/adapters/claude/marketplace/plugins/agmux/bin/agmux-emit`:

```bash
#!/usr/bin/env bash
# Plugin bin/ is on PATH for hook execution; this shim lets hooks call a stable
# name while resolving the real agmux binary (AGMUX_BIN injected by the wrapper,
# else PATH lookup).
exec "${AGMUX_BIN:-agmux}" emit "$@"
```

Then make it executable:

Run: `chmod +x packages/adapters/src/adapters/claude/marketplace/plugins/agmux/bin/agmux-emit`

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude-plugin.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/src/adapters/claude/marketplace packages/adapters/tests/adapters/claude-plugin.test.ts
git commit -m "adapters/claude: static plugin + local marketplace (hooks -> agmux emit)"
```

---

## Task 8: Wire the adapter into the registry + forward AGMUX_BIN

**Files:**
- Modify: `packages/adapters/src/adapters/index.ts`
- Modify: `packages/wrapper/src/index.ts`
- Test: `packages/adapters/tests/registry-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/tests/registry-wiring.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { createDefaultRegistry } from "../src/index.ts";

test("the default registry has the claude adapter wired in", () => {
  const r = createDefaultRegistry();
  expect(r.kinds()).toContain("claude");
  expect(r.lookup("claude")!.agentKind).toBe("claude");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/registry-wiring.test.ts`
Expected: FAIL — `registerAll` is empty; `claude` not registered.

- [ ] **Step 3: Register the adapter (the single provider wiring seam)**

Replace `packages/adapters/src/adapters/index.ts` with:

```typescript
import type { Registry } from "../core/registry.ts";
import { claudeAdapter } from "./claude/index.ts";

// THE per-provider wiring seam. Each provider adds one import + one register()
// call here, and nothing else in core changes.
export function registerAll(registry: Registry): void {
  registry.register(claudeAdapter);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/registry-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Forward AGMUX_BIN through the tmux re-exec**

In `packages/wrapper/src/index.ts`, the child env already forwards everything in `process.env` via `buildChildEnv` (so an inherited `AGMUX_BIN` reaches the agent and its hooks). The only gap is the **selective** env list used when the wrapper re-execs itself into a fresh tmux window. Add `"AGMUX_BIN"` to that `for (const k of [...] as const)` array (the one listing `"AGMUX_INLINE_PROFILE"`, `AGMUX_HUB_URL_ENV`, `AGMUX_SESSION_ID_ENV`, `AGMUX_TMUX_SESSION_ENV`, `AGMUX_PROFILE_ENV`):

```typescript
    for (const k of [
      "AGMUX_INLINE_PROFILE",
      AGMUX_HUB_URL_ENV,
      AGMUX_SESSION_ID_ENV,
      AGMUX_TMUX_SESSION_ENV,
      AGMUX_PROFILE_ENV,
      "AGMUX_BIN",
    ] as const) {
```

- [ ] **Step 6: Typecheck adapters + wrapper**

Run: `bun run --filter @agmux/adapters typecheck && bun run --filter @agmux/wrapper typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/adapters/index.ts packages/wrapper/src/index.ts packages/adapters/tests/registry-wiring.test.ts
git commit -m "adapters/claude: register adapter; wrapper forwards AGMUX_BIN to hooks"
```

---

## Task 9: Full-suite verification + live install smoke

**Files:** none (verification only; no commit unless the manual smoke produces notes).

- [ ] **Step 1: Typecheck every package**

Run: `bun run typecheck`
Expected: no errors across all packages.

- [ ] **Step 2: Run the entire test suite**

Run: `bun test`
Expected: PASS — the prior suite plus the new claude tests. All additive; nothing else should break.

- [ ] **Step 3: Live install smoke (best-effort; requires a real, authenticated `claude` on PATH)**

This exercises the one boundary unit tests can't: the real `/plugin` commands and hook firing. If no live Claude is available in this environment, **record this step as pending** and rely on the automated gates above.

```bash
SCRATCH=$(mktemp -d)
export CLAUDE_CONFIG_DIR="$SCRATCH"
MP="$PWD/packages/adapters/src/adapters/claude/marketplace"
claude -p "/plugin marketplace add $MP"
claude -p "/plugin install agmux@agmux"
claude -p "/plugin list --json"   # expect agmux@agmux present/enabled
```

Verify against the spec §7 pitfalls and record findings (do **not** commit transient scratch dirs):
- Did install require a **trust prompt** (§7.1)? Note the non-interactive incantation that worked, or that it blocks.
- Does `/plugin list --json` actually emit JSON (§7.2)? If not, the runner's text fallback is what's exercised.
- Then in a real wrapped session (`agmux run -p <claude-profile-with-CLAUDE_CONFIG_DIR>`), confirm a turn flips status to `running` then `idle`, and `agmux inspect <id>` shows `usage` accruing.

- [ ] **Step 4: Record any live-smoke findings**

If the smoke surfaced a deviation from the spec (trust flow, JSON shape, Notification fields), append a short "Live verification notes" section to the spec `docs/superpowers/specs/2026-05-29-adapter-claude-design.md` and commit just that doc change:

```bash
git add docs/superpowers/specs/2026-05-29-adapter-claude-design.md
git commit -m "spec/claude: live verification notes"
```

Otherwise (clean, or smoke skipped), make no commit and confirm `git status --short` is clean.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §2 official-plugin install + static marketplace → Tasks 4,5,7,8. §2.1 shipped artifacts → Task 7. §2.2 install/uninstall/status as official commands → Tasks 4–5. §3 source set → Task 1. §3.1 hook→point wiring → Task 7 (hooks.json) + Task 2 (normalize). §4 capability descriptors → Task 1. §5 normalize + usage delta + dedup_key + cursor → Task 2. §6 config-dir isolation + target resolution → Task 5 (`resolveConfigDir`). §6.4/resume → Task 3. §7 pitfalls → exercised/recorded in Task 9 (runner JSON fallback already in Task 4; `runtimeGate:"hook-trust"` in Task 5). §8 touch-points (register + AGMUX_BIN) → Task 8; no hub/store/protocol/CLI change, as designed. §9 deliverables (1 marketplace/plugin, 2 index, 3 fixtures, 4 conformance+fixture tests, 5 register+AGMUX_BIN) → Tasks 1–8. §10 open items → resolved as defaults (ship prompt.sent/tool.used; permission via `notification_type==="permission_prompt"`) and the live trust/JSON checks deferred to Task 9.
- **Placeholder scan:** none — every code/test step is complete; fixtures contain concrete real-shape data; commands have expected output. Task 9's live smoke is explicitly best-effort with a defined fallback (not a placeholder).
- **Type consistency:** `normalizeClaude`, `claudeResumePlan`, `PluginRunner`/`Spawner`/`claudePluginRunner`, `resolveConfigDir`/`claudeInstall`/`claudeUninstall`/`claudeStatus`/`PLUGIN_REF`/`ADAPTER_VERSION`, `CLAUDE_SOURCES`/`CLAUDE_CAPABILITIES`, `createClaudeAdapter`/`claudeAdapter`, `fakePluginRunner` — defined once and referenced consistently. All adapter methods match the landed `Adapter` interface signatures (sync install/uninstall/status/normalize/resumePlan; `normalize(NormalizeInput): NormalizeOutput`). Capability descriptors use the landed `CapabilityMap`/`CapabilityDescriptor` fields (`fulfil`/`source`/`liveness`). `dedup_key` and the usage payload fields match Phase-1 `UsageReport`.
- **Known distribution caveat (documented, not a blocker):** the static marketplace is resolved via `import.meta.dir`; under a `bun build --compile` of the CLI the data files are not auto-bundled. v1 install/smoke run from source (dev). Packaging the marketplace alongside a compiled binary is a follow-on, noted here so it isn't mistaken for done.
