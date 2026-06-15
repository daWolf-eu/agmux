# Codex Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `codex` adapter in `@agmux/adapters`, at parity with the existing `claude` adapter, wiring Codex CLI hooks + rollout usage into agmux's canonical event stream.

**Architecture:** A new `packages/adapters/src/adapters/codex/` module implementing the existing `Adapter` interface, plus one registry line. Capture is via Codex's native hook system (`SessionStart`/`UserPromptSubmit`/`Stop`/`PermissionRequest`/`PostToolUse`) carried by an embedded local-marketplace plugin installed through `codex plugin`; token usage is read from rollout `token_count` records via the `transcript-delta` source. Isolation is `config-dir` via `CODEX_HOME`; resume is `codex resume <id>`.

**Tech Stack:** TypeScript on Bun. `bun:test`. No new deps. Mirrors `packages/adapters/src/adapters/claude/`.

**Spec:** [`docs/superpowers/specs/2026-06-15-adapter-codex-design.md`](../specs/2026-06-15-adapter-codex-design.md)

---

## File Structure

**Create:**
- `packages/adapters/src/adapters/codex/caps.ts` — `CODEX_SOURCES`, `CODEX_CAPABILITIES`
- `packages/adapters/src/adapters/codex/resume.ts` — `codexResumePlan`
- `packages/adapters/src/adapters/codex/normalize.ts` — `normalizeCodex` (hook points + usage)
- `packages/adapters/src/adapters/codex/plugin-files.ts` — embedded marketplace + plugin payload
- `packages/adapters/src/adapters/codex/install.ts` — `codexInstall`/`codexUninstall`/`codexStatus`, `resolveConfigDir`, injectable `codex` runner
- `packages/adapters/src/adapters/codex/index.ts` — the `codexAdapter` object
- `packages/adapters/tests/adapters/codex.test.ts` — caps + normalize + resume + install + conformance
- `packages/adapters/tests/adapters/fixtures/codex/transcript.sample.jsonl` — real rollout `token_count` lines
- `packages/adapters/tests/adapters/fixtures/codex/hook-stdin.sample.json` — reference hook stdin payloads

**Modify:**
- `packages/adapters/src/adapters/index.ts` — register `codexAdapter`
- `packages/adapters/tests/registry-wiring.test.ts` — assert `codex` is wired

**No change needed (verified):** `packages/protocol/src/session.ts` (`AgentKind` already `"claude" | "codex"`), `packages/cli/src/adapter-cmd.ts` (already accepts `--kind codex`), `packages/cli/src/parse-run.ts` (already detects/accepts `codex`).

**Reference (read before starting, do not modify):** `packages/adapters/src/adapters/claude/*` (the template this parallels) and `packages/adapters/src/core/types.ts` (the `Adapter` interface, `InstallContext`, `NormalizeInput`, etc.).

---

### Task 1: Capability sources & descriptors (`caps.ts`)

**Files:**
- Create: `packages/adapters/src/adapters/codex/caps.ts`
- Test: `packages/adapters/tests/adapters/codex.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/tests/adapters/codex.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: FAIL — `Cannot find module '.../codex/caps.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/adapters/codex/caps.ts`:

```ts
import type { CapabilityMap } from "@agmux/protocol";
import type { CapabilitySource } from "../../core/types.ts";

// Two event-triggered sources (spec §3), identical shape to Claude. hook-command
// drives the state machine + log-only points; transcript-delta carries usage (the
// only stateful read — Codex has no usage hook).
export const CODEX_SOURCES: CapabilitySource[] = [
  {
    type: "hook-command",
    activation: "event-triggered",
    points: ["session.registered", "session.linked", "turn.started", "turn.ended", "input.required", "tool.used", "prompt.sent"],
  },
  {
    type: "transcript-delta",
    activation: "event-triggered",
    points: ["usage.reported"],
  },
];

// Finest-grain descriptors (spec §4). input.required is "partial" — Codex's
// PermissionRequest hook is permission-only (no idle/prompt-waiting hook), the
// mirror image of Claude's coarse Notification. input.received is omitted: it is
// fulfilled implicitly by the next turn.started, never emitted.
export const CODEX_CAPABILITIES: CapabilityMap = {
  "session.registered": { fulfil: "yes", source: "hook-command", liveness: "live" },
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

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/codex/caps.ts packages/adapters/tests/adapters/codex.test.ts
git commit -m "adapters: codex capability sources + descriptors"
```

---

### Task 2: Resume plan (`resume.ts`)

**Files:**
- Create: `packages/adapters/src/adapters/codex/resume.ts`
- Test: `packages/adapters/tests/adapters/codex.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/codex.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: FAIL — `Cannot find module '.../codex/resume.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/adapters/codex/resume.ts`:

```ts
import type { ResumeContext, ResumePlan } from "../../core/types.ts";

// `codex resume <id>` resumes the recorded session by its UUID (verified against
// Codex 0.135: `codex resume [OPTIONS] [SESSION_ID]`). Note it is a SUBCOMMAND, not
// a flag — that is the one divergence from Claude's `--resume <id>`. Without a
// native id, fall back to a fresh relaunch.
export function codexResumePlan(ctx: ResumeContext): ResumePlan {
  if (!ctx.nativeSessionId) return { resumable: false };
  return {
    resumable: true,
    argv: [ctx.command, "resume", ctx.nativeSessionId, ...ctx.args],
    cwd: ctx.cwd,
    env: ctx.env,
    nativeSessionId: ctx.nativeSessionId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/codex/resume.ts packages/adapters/tests/adapters/codex.test.ts
git commit -m "adapters: codex resume plan (codex resume <id>)"
```

---

### Task 3: Normalize — hook-command points (`normalize.ts`)

**Files:**
- Create: `packages/adapters/src/adapters/codex/normalize.ts`
- Test: `packages/adapters/tests/adapters/codex.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/codex.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: FAIL — `Cannot find module '.../codex/normalize.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/adapters/codex/normalize.ts` (the usage branch is filled in Task 4; this step stubs it to `{ events: [] }` so the file compiles):

```ts
import * as fs from "node:fs";
import type { NormalizeInput, NormalizeOutput, CanonicalEvent } from "../../core/types.ts";

interface CodexHookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  turn_id?: string;
  model?: string;
  reason?: string;
}

export function normalizeCodex(input: NormalizeInput): NormalizeOutput {
  const raw = (input.raw ?? {}) as CodexHookStdin & Record<string, unknown>;
  // No nesting guard (cf. Claude): Codex exposes no native session-id env var to
  // cross-check against stdin session_id, so nested runs self-register under their
  // own id — the same as Claude's direct/native-exec path (spec §5.3).
  switch (input.point) {
    case "session.registered": {
      if (!raw.session_id) return { events: [] };
      const env = input.env ?? {};
      const pidNum = env.AGMUX_AGENT_PID != null ? Number(env.AGMUX_AGENT_PID) : NaN;
      return { events: [{
        kind: "session.registered",
        payload: {
          native_session_id: raw.session_id,
          agent_kind: "codex",
          pid: Number.isInteger(pidNum) ? pidNum : null,
          cwd: raw.cwd ?? env.PWD ?? null,
          tmux_session: null,
          tmux_window: null,
          tmux_pane: env.TMUX_PANE ?? null,
          profile: env.AGMUX_PROFILE ?? null,
          agent_version: env.CODEX_VERSION ?? null,
          parent: null,
        },
      }] };
    }
    case "session.linked":
      if (!raw.session_id) return { events: [] };
      return { events: [{ kind: "session.linked", payload: { native_session_id: raw.session_id } }] };
    case "turn.started":
      return { events: [{ kind: "turn.started", payload: {} }] };
    case "turn.ended":
      return { events: [{ kind: "turn.ended", payload: { reason: raw.reason ?? null } }] };
    case "input.required":
      // Codex's PermissionRequest hook is always an approval request — no idle/prompt
      // variant exists, so kind is always "permission" (spec §5.1).
      return { events: [{ kind: "input.required", payload: { kind: "permission" } }] };
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

// Filled in Task 4.
function normalizeUsage(_input: NormalizeInput, _raw: CodexHookStdin): NormalizeOutput {
  const _events: CanonicalEvent[] = [];
  return { events: _events };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/codex/normalize.ts packages/adapters/tests/adapters/codex.test.ts
git commit -m "adapters: codex normalize hook-command points"
```

---

### Task 4: Normalize — usage from rollout `token_count` (`normalize.ts`)

**Files:**
- Modify: `packages/adapters/src/adapters/codex/normalize.ts` (replace `normalizeUsage`)
- Create: `packages/adapters/tests/adapters/fixtures/codex/transcript.sample.jsonl`
- Test: `packages/adapters/tests/adapters/codex.test.ts` (append)

- [ ] **Step 1: Create the fixture**

Create `packages/adapters/tests/adapters/fixtures/codex/transcript.sample.jsonl` (real Codex 0.135 rollout shape: `token_count` is nested under an `event_msg` payload; `last_token_usage` is the per-turn delta; a non-usage record is included to prove it is skipped). Each line must be valid JSON on a single line:

```
{"timestamp":"2026-05-29T11:55:30.000Z","type":"response_item","payload":{"type":"message","role":"assistant"}}
{"timestamp":"2026-05-29T11:55:35.492Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10768,"cached_input_tokens":1920,"output_tokens":270,"reasoning_output_tokens":82,"total_tokens":11038},"last_token_usage":{"input_tokens":10768,"cached_input_tokens":1920,"output_tokens":270,"reasoning_output_tokens":82,"total_tokens":11038},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":5.0,"window_minutes":10080,"resets_at":1780600072}}}}
{"timestamp":"2026-05-29T11:55:43.594Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":25797,"cached_input_tokens":12544,"output_tokens":651,"reasoning_output_tokens":164,"total_tokens":26448},"last_token_usage":{"input_tokens":15029,"cached_input_tokens":10624,"output_tokens":381,"reasoning_output_tokens":82,"total_tokens":15410},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":6.0,"window_minutes":10080,"resets_at":1780600072}}}}
```

- [ ] **Step 2: Write the failing test**

Append to `packages/adapters/tests/adapters/codex.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: FAIL — `expect(out.events).toHaveLength(2)` gets `0` (stub `normalizeUsage`).

- [ ] **Step 4: Write the implementation**

In `packages/adapters/src/adapters/codex/normalize.ts`, replace the stub `normalizeUsage` with:

```ts
// Read NEW rollout records since the byte cursor. Codex writes token_count as an
// `event_msg` whose payload.type === "token_count"; info.last_token_usage is the
// per-turn delta (info.total_token_usage is the session total — we want the delta
// so session_usage accumulates). Codex records have no stable per-record uuid, so
// the dedup key uses the record's byte offset (monotonic, stable across re-reads).
function normalizeUsage(input: NormalizeInput, raw: CodexHookStdin): NormalizeOutput {
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
  const model = raw.model ?? null;
  const events: CanonicalEvent[] = [];
  let offset = start;
  for (const line of consumable.split("\n")) {
    const recOffset = offset;
    offset += Buffer.byteLength(line, "utf8") + 1; // +1 for the consumed "\n"
    if (line.trim() === "") continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    let tc: any = null;
    if (rec?.type === "event_msg" && rec.payload?.type === "token_count") tc = rec.payload;
    else if (rec?.type === "token_count") tc = rec; // defensive: future flattened shape
    if (!tc) continue;
    const u = tc.info?.last_token_usage;
    if (!u) continue;
    events.push({
      kind: "usage.reported",
      payload: {
        cumulative: false,
        source: "transcript-delta",
        model,
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cache_read_tokens: u.cached_input_tokens ?? null,
        cache_write_tokens: null, // Codex exposes no write-cache figure
        reasoning_output_tokens: u.reasoning_output_tokens ?? null,
        total_tokens: u.total_tokens ?? null,
        model_context_window: tc.info?.model_context_window ?? null,
        rate_limit: tc.rate_limits?.primary ?? null,
        turn_id: raw.turn_id ?? null,
        as_of: rec.timestamp ?? null,
      },
      dedup_key: `codex:transcript-delta:${nativeId}:${recOffset}`,
    });
  }
  return { events, cursor: String(newCursor) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/adapters/codex/normalize.ts packages/adapters/tests/adapters/fixtures/codex/transcript.sample.jsonl packages/adapters/tests/adapters/codex.test.ts
git commit -m "adapters: codex usage.reported from rollout token_count"
```

---

### Task 5: Embedded marketplace + plugin payload (`plugin-files.ts`)

**Files:**
- Create: `packages/adapters/src/adapters/codex/plugin-files.ts`
- Test: `packages/adapters/tests/adapters/codex.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/codex.test.ts`:

```ts
import { MARKETPLACE_FILES, PLUGIN_VERSION, MARKETPLACE_NAME, PLUGIN_NAME } from "../../src/adapters/codex/plugin-files.ts";

test("marketplace payload contains manifest, plugin manifest, hooks, and an executable shim", () => {
  const byPath = new Map(MARKETPLACE_FILES.map((f) => [f.path, f]));
  expect(byPath.has(".agents/plugins/marketplace.json")).toBe(true);
  expect(byPath.has("plugins/agmux/.codex-plugin/plugin.json")).toBe(true);
  expect(byPath.has("plugins/agmux/hooks/hooks.json")).toBe(true);
  expect(byPath.get("plugins/agmux/bin/agmux-emit")!.mode & 0o111).not.toBe(0); // executable
});

test("marketplace manifest references the local plugin; plugin manifest carries the version", () => {
  const mkt = JSON.parse(MARKETPLACE_FILES.find((f) => f.path === ".agents/plugins/marketplace.json")!.content);
  expect(mkt.name).toBe(MARKETPLACE_NAME);
  expect(mkt.plugins[0]).toMatchObject({ name: PLUGIN_NAME, source: { source: "local", path: "./plugins/agmux" } });
  const plugin = JSON.parse(MARKETPLACE_FILES.find((f) => f.path === "plugins/agmux/.codex-plugin/plugin.json")!.content);
  expect(plugin).toMatchObject({ name: PLUGIN_NAME, version: PLUGIN_VERSION });
});

test("hooks wire every manifest point to `agmux emit --from=codex`", () => {
  const hooks = JSON.parse(MARKETPLACE_FILES.find((f) => f.path === "plugins/agmux/hooks/hooks.json")!.content).hooks;
  const all = JSON.stringify(hooks);
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse"]) {
    expect(Object.keys(hooks)).toContain(ev);
  }
  expect(all).toContain("--from=codex");
  expect(all).toContain("--point=session.registered");
  expect(all).toContain("--point=usage.reported");
  expect(all).toContain("--point=input.required");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: FAIL — `Cannot find module '.../codex/plugin-files.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/adapters/codex/plugin-files.ts`:

```ts
// The agmux Codex plugin payload, embedded as code (cf. claude/plugin-files.ts).
// install() WRITES these files to a stable dir and registers it as a LOCAL
// marketplace, so the adapter works identically from source and from a
// `bun build --compile` binary (where import.meta.dir is virtual). No published
// package, no network — the only externality is the `codex` binary on PATH.

export const PLUGIN_VERSION = "1.0.0";
export const MARKETPLACE_NAME = "agmux";
export const PLUGIN_NAME = "agmux";

// Hooks run via shell so ${AGMUX_BIN:-agmux} and $AGMUX_SESSION_ID expand at fire
// time; --from=codex selects this adapter's normalize() inside `agmux emit`.
const EMIT = "${AGMUX_BIN:-agmux} emit --from=codex";

const MARKETPLACE_MANIFEST = {
  name: MARKETPLACE_NAME,
  interface: { displayName: "agmux" },
  plugins: [
    {
      name: PLUGIN_NAME,
      source: { source: "local", path: "./plugins/agmux" },
      policy: { installation: "AVAILABLE" },
    },
  ],
};

const PLUGIN_MANIFEST = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description: "agmux session telemetry integration",
  hooks: "./hooks/hooks.json",
};

// Hook wiring (spec §3.1): all async so they never delay Codex. session.registered
// captures the agent pid via $PPID (the hook shell's parent is the codex process).
const HOOKS = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          { type: "command", async: true, command: `AGMUX_AGENT_PID=$PPID ${EMIT} --source=hook-command --point=session.registered` },
          { type: "command", async: true, command: `${EMIT} --attach` },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=turn.started` },
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=prompt.sent` },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=turn.ended` },
          { type: "command", async: true, command: `${EMIT} --source=transcript-delta --point=usage.reported --cursor-file="$HOME/.agmux/cursors/codex-$AGMUX_SESSION_ID.cursor"` },
        ],
      },
    ],
    PermissionRequest: [
      {
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=input.required` },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=tool.used` },
        ],
      },
    ],
  },
};

const SHIM = `#!/usr/bin/env bash
# Plugin bin/ is on PATH for hook execution; this shim lets hooks call a stable
# name while resolving the real agmux binary (AGMUX_BIN injected by the wrapper,
# else PATH lookup).
exec "\${AGMUX_BIN:-agmux}" emit "$@"
`;

export interface MarketplaceFile {
  path: string;  // relative to the materialized marketplace root
  content: string;
  mode: number;
}

export const MARKETPLACE_FILES: MarketplaceFile[] = [
  { path: ".agents/plugins/marketplace.json", content: JSON.stringify(MARKETPLACE_MANIFEST, null, 2) + "\n", mode: 0o644 },
  { path: "plugins/agmux/.codex-plugin/plugin.json", content: JSON.stringify(PLUGIN_MANIFEST, null, 2) + "\n", mode: 0o644 },
  { path: "plugins/agmux/hooks/hooks.json", content: JSON.stringify(HOOKS, null, 2) + "\n", mode: 0o644 },
  { path: "plugins/agmux/bin/agmux-emit", content: SHIM, mode: 0o755 },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: PASS (17 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/codex/plugin-files.ts packages/adapters/tests/adapters/codex.test.ts
git commit -m "adapters: codex embedded marketplace + plugin payload"
```

---

### Task 6: Install / uninstall / status (`install.ts`)

**Files:**
- Create: `packages/adapters/src/adapters/codex/install.ts`
- Test: `packages/adapters/tests/adapters/codex.test.ts` (append)

The `codex` binary is invoked through an **injectable runner** so tests are hermetic (no real `codex`, no auth). Production uses the default runner (`spawnSync("codex", …)`); tests inject a stateful fake.

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/codex.test.ts`:

```ts
import { resolveConfigDir, marketplaceDir, codexInstall, codexUninstall, codexStatus, setCodexRunner, ADAPTER_VERSION, type CodexRunner } from "../../src/adapters/codex/install.ts";
import * as os from "node:os";
import * as fs from "node:fs";

// Stateful fake `codex` CLI: tracks install state per CODEX_HOME and renders a
// realistic `codex plugin list` table. `versionOverride` lets a test force drift.
function makeFakeCodex(versionOverride?: string) {
  const installed = new Set<string>();
  const calls: string[][] = [];
  const run: CodexRunner = (args, env) => {
    calls.push(args);
    const home = env.CODEX_HOME ?? "";
    const sub = args.join(" ");
    if (sub === "plugin add agmux@agmux") { installed.add(home); return { code: 0, stdout: "", stderr: "" }; }
    if (sub === "plugin remove agmux@agmux") { installed.delete(home); return { code: 0, stdout: "", stderr: "" }; }
    if (sub === "plugin list") {
      const ver = versionOverride ?? PLUGIN_VERSION;
      const row = installed.has(home)
        ? `agmux@agmux   installed      ${ver}  /x`
        : `agmux@agmux   not installed          /x`;
      return { code: 0, stdout: `PLUGIN        STATUS         VERSION  PATH\n${row}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" }; // marketplace add/remove
  };
  return { run, calls, installed };
}

function tmpCfg(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-codex-cfg-")); }
function tmpState(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-codex-state-")); }

const ictx = (configDir: string | undefined, stateDir: string, profile: string | null = null, override: string | null = null) => ({
  agentKind: "codex" as const, profile,
  profileEnv: (configDir ? { CODEX_HOME: configDir } : {}) as Record<string, string>,
  agmuxEmitPath: "/abs/agmux emit", stateDir,
  ...(override ? { configDirOverride: override } : {}),
});

test("resolveConfigDir: explicit override > profileEnv CODEX_HOME > default ~/.codex", () => {
  expect(resolveConfigDir(ictx("/cfg", "/s"))).toBe("/cfg");
  expect(resolveConfigDir(ictx("/cfg", "/s", null, "/override"))).toBe("/override");
  expect(resolveConfigDir(ictx(undefined, "/s")).endsWith("/.codex")).toBe(true);
});

test("install materializes the marketplace, runs codex plugin add, and flips status; uninstall reverses", () => {
  const fake = makeFakeCodex();
  setCodexRunner(fake.run);
  try {
    const cfg = tmpCfg();
    const state = tmpState();
    const ctx = ictx(cfg, state, "work");

    expect(codexStatus(ctx).installed).toBe(false);
    const rec = codexInstall(ctx);
    expect(rec).toMatchObject({ agentKind: "codex", profile: "work", adapterVersion: ADAPTER_VERSION, isolationMode: "config-dir" });

    // Marketplace fully materialized on disk.
    const mkt = marketplaceDir(state);
    expect(fs.existsSync(path.join(mkt, ".agents/plugins/marketplace.json"))).toBe(true);
    expect(fs.existsSync(path.join(mkt, "plugins/agmux/hooks/hooks.json"))).toBe(true);
    expect(fs.statSync(path.join(mkt, "plugins/agmux/bin/agmux-emit")).mode & 0o111).not.toBe(0);

    // The official commands were invoked, CODEX_HOME-scoped.
    expect(fake.calls.some((c) => c[0] === "plugin" && c[1] === "marketplace" && c[2] === "add")).toBe(true);
    expect(fake.calls.some((c) => c.join(" ") === "plugin add agmux@agmux")).toBe(true);

    expect(codexStatus(ctx)).toMatchObject({ installed: true, version: ADAPTER_VERSION, drift: false, runtimeGate: "hook-trust" });

    codexUninstall(ctx, rec);
    expect(codexStatus(ctx).installed).toBe(false);
  } finally {
    setCodexRunner(null);
  }
});

test("status reports drift when the installed plugin version differs from the embedded payload", () => {
  const fake = makeFakeCodex("0.0.1-stale");
  setCodexRunner(fake.run);
  try {
    const ctx = ictx(tmpCfg(), tmpState());
    codexInstall(ctx);
    expect(codexStatus(ctx).drift).toBe(true);
  } finally {
    setCodexRunner(null);
  }
});

test("separate CODEX_HOME dirs install independently (profile isolation)", () => {
  const fake = makeFakeCodex();
  setCodexRunner(fake.run);
  try {
    const state = tmpState();
    const cfgA = tmpCfg();
    const cfgB = tmpCfg();
    codexInstall(ictx(cfgA, state));
    expect(codexStatus(ictx(cfgA, state)).installed).toBe(true);
    expect(codexStatus(ictx(cfgB, state)).installed).toBe(false);
  } finally {
    setCodexRunner(null);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: FAIL — `Cannot find module '.../codex/install.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/adapters/codex/install.ts`:

```ts
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InstallContext, InstallRecord, InstallStatus } from "../../core/types.ts";
import { CODEX_CAPABILITIES } from "./caps.ts";
import { MARKETPLACE_FILES, PLUGIN_VERSION, MARKETPLACE_NAME, PLUGIN_NAME } from "./plugin-files.ts";

export const ADAPTER_VERSION = "1";
const PLUGIN_REF = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`; // "agmux@agmux"

// Install model (spec §2): ship an embedded plugin behind a LOCAL marketplace and
// drive Codex's official `codex plugin` commands, scoped to the target CODEX_HOME.
// The `codex` binary is invoked through an injectable runner so install logic is
// unit-testable without the real CLI/auth.

export interface CodexRunResult { code: number; stdout: string; stderr: string; }
export type CodexRunner = (args: string[], env: Record<string, string>) => CodexRunResult;

const defaultRunner: CodexRunner = (args, env) => {
  const r = cp.spawnSync("codex", args, { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

let runner: CodexRunner = defaultRunner;
// Test seam: inject a fake `codex` runner; pass null to restore the real one.
export function setCodexRunner(r: CodexRunner | null): void { runner = r ?? defaultRunner; }

// config-dir isolation (spec §6): explicit CLI override wins, then the profile's
// own CODEX_HOME, then the default. Mirrors Claude's CLAUDE_CONFIG_DIR resolution.
export function resolveConfigDir(ctx: InstallContext): string {
  return ctx.configDirOverride ?? ctx.profileEnv.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function marketplaceDir(stateDir: string): string {
  return path.join(stateDir, "codex", "marketplace");
}

function materialize(stateDir: string): string {
  const dest = marketplaceDir(stateDir);
  fs.rmSync(dest, { recursive: true, force: true }); // idempotent: refresh in place
  for (const f of MARKETPLACE_FILES) {
    const target = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, { mode: f.mode });
  }
  return dest;
}

export function codexInstall(ctx: InstallContext): InstallRecord {
  const configDir = resolveConfigDir(ctx);
  const env = { CODEX_HOME: configDir };
  const mkt = materialize(ctx.stateDir);
  runner(["plugin", "marketplace", "add", mkt], env);
  runner(["plugin", "add", PLUGIN_REF], env);
  const configToml = path.join(configDir, "config.toml");
  return {
    agentKind: "codex",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: CODEX_CAPABILITIES,
    artifacts: [
      { kind: "config-key", path: configToml, detail: `plugin ${PLUGIN_REF}`, restore: null },
      { kind: "config-key", path: configToml, detail: `marketplace ${MARKETPLACE_NAME}`, restore: null },
    ],
  };
}

export function codexUninstall(ctx: InstallContext, _record: InstallRecord): void {
  const env = { CODEX_HOME: resolveConfigDir(ctx) };
  runner(["plugin", "remove", PLUGIN_REF], env);
  runner(["plugin", "marketplace", "remove", MARKETPLACE_NAME], env);
}

export function codexStatus(ctx: InstallContext): InstallStatus {
  const env = { CODEX_HOME: resolveConfigDir(ctx) };
  const { stdout } = runner(["plugin", "list"], env);
  const line = stdout.split("\n").find((l) => l.trim().startsWith(PLUGIN_REF));
  if (!line) return { installed: false, version: null, drift: false, runtimeGate: "hook-trust" };
  // Columns: `PLUGIN STATUS VERSION PATH`. After the ref, STATUS is "installed" or
  // "not installed" — test "not " first since it contains "installed" as a substring.
  const after = line.trim().slice(PLUGIN_REF.length).trim();
  if (!after.startsWith("installed")) {
    return { installed: false, version: null, drift: false, runtimeGate: "hook-trust" };
  }
  const reportedVersion = after.slice("installed".length).trim().split(/\s+/)[0] || null;
  const drift = reportedVersion !== null && reportedVersion !== PLUGIN_VERSION;
  // Hook activation may still be gated by Codex's hook-trust model at session start
  // (spec §7.3); kept until a live wrapped session proves hooks fire ungated.
  return { installed: true, version: ADAPTER_VERSION, drift, runtimeGate: "hook-trust" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: PASS (21 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/codex/install.ts packages/adapters/tests/adapters/codex.test.ts
git commit -m "adapters: codex install/uninstall/status via codex plugin"
```

---

### Task 7: The adapter object (`index.ts`) + conformance

**Files:**
- Create: `packages/adapters/src/adapters/codex/index.ts`
- Test: `packages/adapters/tests/adapters/codex.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/codex.test.ts`:

```ts
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { assertAdapterConformance } from "../../src/core/conformance.ts";

test("the codexAdapter exposes the expected shape", () => {
  expect(codexAdapter.agentKind).toBe("codex");
  expect(codexAdapter.sources({} as any).length).toBe(2);
  expect(Object.keys(codexAdapter.capabilities({} as any))).toContain("usage.reported");
  // Codex has no native session-id env var → nativeIdFromEnv is intentionally omitted.
  expect(codexAdapter.nativeIdFromEnv).toBeUndefined();
});

test("codexAdapter passes the framework conformance battery (fake codex runner)", () => {
  const fake = makeFakeCodex();
  setCodexRunner(fake.run);
  try {
    const cfg = tmpCfg();
    const state = tmpState();
    const passed = assertAdapterConformance(codexAdapter, {
      makeContext: () => ({ agentKind: "codex", profile: null, profileEnv: { CODEX_HOME: cfg }, agmuxEmitPath: "/abs/agmux emit", stateDir: state }),
      makeResumeContext: (nid) => ({ agentKind: "codex", profile: null, command: "codex", args: [], cwd: "/work", env: {}, nativeSessionId: nid }),
    });
    expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan"]);
  } finally {
    setCodexRunner(null);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: FAIL — `Cannot find module '.../codex/index.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/adapters/codex/index.ts`:

```ts
import type { Adapter } from "../../core/types.ts";
import { CODEX_SOURCES, CODEX_CAPABILITIES } from "./caps.ts";
import { normalizeCodex } from "./normalize.ts";
import { codexResumePlan } from "./resume.ts";
import { codexInstall, codexUninstall, codexStatus, ADAPTER_VERSION } from "./install.ts";

// The plugin payload is embedded code (plugin-files.ts) materialized at install
// time — no on-disk data files, so the adapter behaves identically from source and
// from a compiled agmux binary. nativeIdFromEnv is omitted: Codex exposes no native
// session-id env var, so identity is taken from hook stdin (spec §5.3).
export const codexAdapter: Adapter = {
  agentKind: "codex",
  adapterVersion: ADAPTER_VERSION,
  sources: () => CODEX_SOURCES,
  capabilities: () => CODEX_CAPABILITIES,
  install: codexInstall,
  uninstall: codexUninstall,
  status: codexStatus,
  normalize: normalizeCodex,
  resumePlan: codexResumePlan,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: PASS (23 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/codex/index.ts packages/adapters/tests/adapters/codex.test.ts
git commit -m "adapters: assemble codexAdapter + conformance"
```

---

### Task 8: Register in the default registry

**Files:**
- Modify: `packages/adapters/src/adapters/index.ts`
- Test: `packages/adapters/tests/registry-wiring.test.ts`

- [ ] **Step 1: Update the failing test**

Replace the full contents of `packages/adapters/tests/registry-wiring.test.ts` with:

```ts
import { test, expect } from "bun:test";
import { createDefaultRegistry } from "../src/index.ts";

test("the default registry has the claude adapter wired in", () => {
  const r = createDefaultRegistry();
  expect(r.kinds()).toContain("claude");
  expect(r.lookup("claude")!.agentKind).toBe("claude");
});

test("the default registry has the codex adapter wired in", () => {
  const r = createDefaultRegistry();
  expect(r.kinds()).toContain("codex");
  expect(r.lookup("codex")!.agentKind).toBe("codex");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/registry-wiring.test.ts`
Expected: FAIL — `expect(r.kinds()).toContain("codex")` (codex not registered yet).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `packages/adapters/src/adapters/index.ts` with:

```ts
import type { Registry } from "../core/registry.ts";
import { claudeAdapter } from "./claude/index.ts";
import { codexAdapter } from "./codex/index.ts";

// THE per-provider wiring seam. Each provider adds one import + one register()
// call here, and nothing else in core changes.
export function registerAll(registry: Registry): void {
  registry.register(claudeAdapter);
  registry.register(codexAdapter);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/registry-wiring.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/index.ts packages/adapters/tests/registry-wiring.test.ts
git commit -m "adapters: register codex in the default registry"
```

---

### Task 9: Reference hook-stdin fixture (documentation)

Codex hook stdin is documented (developers.openai.com/codex/hooks); committing a reference sample aids future maintainers and parallels the Claude fixture. Tests use inline `raw` (Tasks 3–4), so this file is documentation only.

**Files:**
- Create: `packages/adapters/tests/adapters/fixtures/codex/hook-stdin.sample.json`

- [ ] **Step 1: Create the fixture**

Create `packages/adapters/tests/adapters/fixtures/codex/hook-stdin.sample.json` (one example payload per wired hook; fields per the Codex hooks docs — common: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`; turn-scoped add `turn_id`):

```json
{
  "SessionStart": { "session_id": "019e7396-de62-7f91-9a3d-df4b0a99aaaf", "transcript_path": "/Users/me/.codex/sessions/2026/05/29/rollout-2026-05-29T13-55-27-019e7396-de62-7f91-9a3d-df4b0a99aaaf.jsonl", "cwd": "/work", "hook_event_name": "SessionStart", "model": "gpt-5.5", "permission_mode": "default", "source": "startup" },
  "UserPromptSubmit": { "session_id": "019e7396-de62-7f91-9a3d-df4b0a99aaaf", "cwd": "/work", "hook_event_name": "UserPromptSubmit", "model": "gpt-5.5", "permission_mode": "default", "turn_id": "t-1", "prompt": "refactor the parser" },
  "Stop": { "session_id": "019e7396-de62-7f91-9a3d-df4b0a99aaaf", "transcript_path": "/Users/me/.codex/sessions/2026/05/29/rollout-2026-05-29T13-55-27-019e7396-de62-7f91-9a3d-df4b0a99aaaf.jsonl", "cwd": "/work", "hook_event_name": "Stop", "model": "gpt-5.5", "permission_mode": "default", "turn_id": "t-1", "stop_hook_active": false, "last_assistant_message": "done" },
  "PermissionRequest": { "session_id": "019e7396-de62-7f91-9a3d-df4b0a99aaaf", "cwd": "/work", "hook_event_name": "PermissionRequest", "model": "gpt-5.5", "permission_mode": "default", "turn_id": "t-1", "tool_name": "Bash", "tool_input": { "command": "rm -rf build" } },
  "PostToolUse": { "session_id": "019e7396-de62-7f91-9a3d-df4b0a99aaaf", "cwd": "/work", "hook_event_name": "PostToolUse", "model": "gpt-5.5", "permission_mode": "default", "turn_id": "t-1", "tool_name": "Bash", "tool_use_id": "tu-1", "tool_input": { "command": "ls" }, "tool_response": { "exit_code": 0 } }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/adapters/tests/adapters/fixtures/codex/hook-stdin.sample.json
git commit -m "adapters: codex hook-stdin reference fixture"
```

---

### Task 10: Full suite + typecheck

**Files:** none (verification only).

- [ ] **Step 1: Run the full adapters test suite**

Run: `bun test packages/adapters`
Expected: PASS — all existing claude/core tests plus the new codex tests green; no regressions.

- [ ] **Step 2: Typecheck the workspace**

Run: `bun run typecheck`
Expected: clean (no type errors). If the repo has no root `typecheck` script, run `bunx tsc --noEmit -p packages/adapters/tsconfig.json` (or the project's documented typecheck command).

- [ ] **Step 3: Run the CLI adapter-command suite (no regression on shared paths)**

Run: `bun test packages/cli/tests/adapter-cmd.test.ts`
Expected: PASS — `--kind codex` already resolves to the now-registered adapter.

- [ ] **Step 4: Commit (only if any fix was needed above)**

```bash
git add -A
git commit -m "adapters: codex suite + typecheck green"
```

---

### Task 11: Live verification against a scratch CODEX_HOME (manual, gated)

This exercises the **real** `codex` binary (the §7 pitfalls the unit tests stub out). It is a manual acceptance step, not an automated test, and must use a scratch `CODEX_HOME` so it never touches the user's real Codex config.

**Files:** none (manual verification; record findings as a spec §7 update if reality diverges).

- [ ] **Step 1: Build the agmux binary (so `agmux emit` resolves on PATH for hooks)**

Run the project's build (e.g. `bun run build`) or note the absolute path to the dev `agmux` entry for `AGMUX_BIN`.

- [ ] **Step 2: Install into a scratch CODEX_HOME via the real adapter path**

Run:
```bash
export AGMUX_SCRATCH=$(mktemp -d)
bun run packages/cli/bin/agmux.ts adapter install --kind codex --config-dir "$AGMUX_SCRATCH"
```
Expected: `installed codex (bare) (v1)`. Verify with:
```bash
CODEX_HOME="$AGMUX_SCRATCH" codex plugin list
```
Expected: an `agmux@agmux` row with STATUS `installed`.

- [ ] **Step 3: Confirm status, then uninstall**

Run:
```bash
bun run packages/cli/bin/agmux.ts adapter status --kind codex --config-dir "$AGMUX_SCRATCH"
bun run packages/cli/bin/agmux.ts adapter uninstall --kind codex --config-dir "$AGMUX_SCRATCH"
```
Expected: `status` reports installed; `uninstall` reports success; a follow-up `status` reports not installed.

- [ ] **Step 4: Verify §7 pitfalls against reality; update the spec if anything diverged**

Confirm each spec §7 item or record the actual behavior in `docs/superpowers/specs/2026-06-15-adapter-codex-design.md` §7/§11:
  1. exact `codex plugin add` / `list` argument forms and the STATUS/VERSION parse;
  2. whether install needs a hook-trust pre-seed (and the non-interactive path);
  3. `token_count` envelope confirmed (`event_msg.payload.type === "token_count"`) against a freshly-recorded rollout;
  4. `SessionStart` matcher honored;
  5. `PermissionRequest` stdin field for `kind`;
  6. whether `CODEX_VERSION` (or similar) is present in the hook env for `agent_version`.

- [ ] **Step 5: Commit any spec updates**

```bash
git add docs/superpowers/specs/2026-06-15-adapter-codex-design.md
git commit -m "docs: codex adapter live-verification notes"
```

---

## Notes for the implementer

- **`bun test packages/adapters/tests/adapters/codex.test.ts`** is the tight inner loop for Tasks 1–7; the test file grows by appending each task's block.
- **Never call the real `codex` binary in unit tests** — always wrap install/status/uninstall tests in `setCodexRunner(fake.run)` / `finally { setCodexRunner(null) }`. The default runner is only for production and Task 11.
- **Mirror the Claude adapter** (`packages/adapters/src/adapters/claude/`) for any unstated convention — the codex module is a deliberate parallel.
- **Divergences from Claude** (don't "fix" them to match): `codex resume <id>` is a subcommand not a flag; no `nativeIdFromEnv`; no nesting guard; usage from `token_count.last_token_usage` with byte-offset dedup; install via `codex plugin` not a filesystem drop.
