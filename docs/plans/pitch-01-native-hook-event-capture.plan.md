# Pitch 01 — Native-Hook Capture: Residual Fidelity Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two genuinely-missing pieces of native-hook capture — faithful tool success/failure recording (claude + codex) and a first-class `compaction` event — both purely additive and migration-free.

**Architecture:** All changes ride the existing native-first adapter pipeline (`hook → emit → normalize → stampIngest → ingest → resolve → project`). Tool-failure is an adapter-layer fix (`normalize` reads provider stdin instead of hardcoding `ok: true`). The `compaction` event is a new additive event kind wired Claude-only (protocol → adapters core → claude adapter → store), defaulting to log-only in the projection so no DB migration is needed.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, `bun:test`. Monorepo packages: `@agmux/protocol`, `@agmux/adapters`, `@agmux/store`.

---

## Why this plan exists (critical evaluation of the pitch — read first)

The backlog pitch [`docs/backlog/01-native-hook-event-capture.md`](../backlog/01-native-hook-event-capture.md) proposes porting omnigent's native-hook capture: a per-harness hook matrix, a payload→event normalization table, a thin `stdin→JSON→ingest` adapter contract, self-registration, and a working Claude adapter spike.

**That work is ~90% already done in this repo.** It was delivered by the native-first design ([`docs/superpowers/specs/2026-06-05-native-first-design.md`](../superpowers/specs/2026-06-05-native-first-design.md)) plus three landed adapters:

| Pitch deliverable | Already in codebase |
|---|---|
| Per-harness hook set | `packages/adapters/src/adapters/{claude,codex,pi}/plugin-files.ts` / `extension-files.ts` |
| omnigent payload→event normalization table | `core/normalize.ts` + per-adapter `normalize.ts` (`tool.used`, `prompt.sent`, `turn.*`, `usage.reported`, `session.registered`) |
| `stdin→JSON→ingest` adapter contract | `core/types.ts` `Adapter` interface + `cli emit` + `core/normalize.ts` `stampIngestEvents` |
| Self-registration / native identity resolved at hub | `session.registered` event + `store/resolve.ts` resolve rules |
| Append-not-block discipline ("fast channel") | every hook is `async: true` |
| Working Claude adapter spike | shipped + Codex + pi |

Re-executing the pitch verbatim would be redundant. What remains genuinely unbuilt are two fidelity deltas vs. omnigent's capture set, both confirmed against the code:

1. **Tool-failure fidelity.** `tool.used.ok` is hardcoded `true` in `claude/normalize.ts:67` and `codex/normalize.ts:55`, even though PostToolUse stdin carries a failure signal (`tool_response.exit_code` for codex). Only `pi/normalize.ts:54` reads a real signal (`is_error`). Failed tools are recorded as successes — analytics over the event log can never see a failure.
2. **No `compaction` event.** Foundation §6 lists `compaction` as a first-class event kind, but it does not exist. Today `/compact` only triggers SessionStart re-registration (identity rotation, `resolve.ts` rule 3); the *fact* of a compaction is never recorded as a queryable event.

**Out of scope (deliberate):** output/text-delta streaming capture (a documented non-goal of the native-first spec), a `PreToolUse`→`tool-call`/`tool-result` split, and a `compaction_count` projection column (would require a store migration). These are noted as deferred backlog items in the final section.

---

## File Structure

**Part A — Tool-failure fidelity (adapter-layer only):**
- Modify: `packages/adapters/src/adapters/codex/normalize.ts` — `tool.used` reads `tool_response.exit_code`.
- Modify: `packages/adapters/src/adapters/claude/normalize.ts` — `tool.used` reads `tool_response.is_error`/`success`.
- Modify: `packages/adapters/tests/adapters/codex.test.ts`, `claude.test.ts` — failure-case coverage.
- Modify: `packages/adapters/tests/adapters/fixtures/{codex,claude}/hook-stdin.sample.json` — add a failed-tool fixture.
- Modify: `packages/protocol/src/validators.ts` — tighten `tool.used` to assert `ok` is `boolean|null` when present.
- Modify: `packages/protocol/tests/validators.test.ts`.

**Part B — `compaction` event (additive, Claude-only, migration-free):**
- Modify: `packages/protocol/src/events.ts` — add kind, `CompactionPayload`, `CompactionEvent`, `KnownEvent`.
- Modify: `packages/protocol/src/validators.ts` — `case "compaction"`.
- Modify: `packages/protocol/tests/{events-types,validators}.test.ts`.
- Modify: `packages/adapters/src/core/types.ts` — add `"compaction"` to `MANIFEST_POINTS`.
- Modify: `packages/adapters/src/adapters/claude/normalize.ts` — `case "compaction"`.
- Modify: `packages/adapters/src/adapters/claude/caps.ts` — add to `CLAUDE_SOURCES` + `CLAUDE_CAPABILITIES`.
- Modify: `packages/adapters/src/adapters/claude/plugin-files.ts` — `PreCompact` hook; bump `PLUGIN_VERSION` to `1.3.0`.
- Modify: `packages/adapters/tests/adapters/claude.test.ts`, `claude-plugin.test.ts`.
- Modify: `packages/store/src/project.ts` — explicit log-only `case "compaction"`.
- Modify: `packages/store/tests/project.test.ts`.

**Conventions to follow (verified in repo):**
- Run tests from the repo root with `bun test <path>` (e.g. `bun test packages/adapters/tests/adapters/codex.test.ts`).
- `normalize` is a pure function: `(NormalizeInput) → NormalizeOutput`. Test it directly with hand-built inputs — no fs unless reading transcripts.
- Commit messages: short, no AI attribution (per repo convention). No JIRA key for this repo.

---

# Part A — Tool-failure fidelity

## Task A1: Codex `tool.used` reports real success/failure

**Files:**
- Modify: `packages/adapters/src/adapters/codex/normalize.ts:54-55`
- Modify: `packages/adapters/tests/adapters/fixtures/codex/hook-stdin.sample.json`
- Test: `packages/adapters/tests/adapters/codex.test.ts`

- [ ] **Step 1: Add a failed-tool fixture**

In `packages/adapters/tests/adapters/fixtures/codex/hook-stdin.sample.json`, add a `PostToolUseFail` key alongside the existing `PostToolUse` (keep `PostToolUse` unchanged):

```json
  "PostToolUseFail": { "session_id": "019e7396-de62-7f91-9a3d-df4b0a99aaaf", "cwd": "/work", "hook_event_name": "PostToolUse", "model": "gpt-5.5", "permission_mode": "default", "turn_id": "t-1", "tool_name": "Bash", "tool_use_id": "tu-2", "tool_input": { "command": "false" }, "tool_response": { "exit_code": 1 } }
```

- [ ] **Step 2: Write the failing test**

Append to `packages/adapters/tests/adapters/codex.test.ts` (follow the file's existing import + `target` style):

```ts
test("tool.used reflects exit_code: 0 → ok, non-zero → fail, absent → ok", () => {
  const t = { agentKind: "codex" as const, profile: null };
  const ok = normalizeCodex({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash", tool_response: { exit_code: 0 } }, target: t });
  expect(ok.events[0]?.payload).toEqual({ tool: "Bash", ok: true });

  const fail = normalizeCodex({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash", tool_response: { exit_code: 1 } }, target: t });
  expect(fail.events[0]?.payload).toEqual({ tool: "Bash", ok: false, detail: "exit 1" });

  // No tool_response (e.g. a non-shell tool) → default to ok, no detail.
  const absent = normalizeCodex({ point: "tool.used", source: "hook-command", raw: { tool_name: "apply_patch" }, target: t });
  expect(absent.events[0]?.payload).toEqual({ tool: "apply_patch", ok: true });
});
```

> If `normalizeCodex` is not already imported at the top of `codex.test.ts`, add: `import { normalizeCodex } from "../../src/adapters/codex/normalize.ts";`

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts -t "tool.used reflects exit_code"`
Expected: FAIL — current code returns `{ tool: "Bash", ok: true }` for the `exit_code: 1` case.

- [ ] **Step 4: Implement**

In `packages/adapters/src/adapters/codex/normalize.ts`, add the `CodexHookStdin` field and replace the `tool.used` case.

Add to the `CodexHookStdin` interface (near line 4-13):

```ts
  tool_response?: { exit_code?: number } & Record<string, unknown>;
```

Replace the `case "tool.used":` block (line 54-55):

```ts
    case "tool.used": {
      const tool = typeof raw.tool_name === "string" ? raw.tool_name : "unknown";
      // Codex shell tools report a numeric exit_code in tool_response; non-zero is a
      // failure. Tools without an exit_code (e.g. apply_patch) carry no failure
      // signal here, so we default to ok — never invent a failure we can't see.
      const code = raw.tool_response?.exit_code;
      if (typeof code === "number" && code !== 0) {
        return { events: [{ kind: "tool.used", payload: { tool, ok: false, detail: `exit ${code}` } }] };
      }
      return { events: [{ kind: "tool.used", payload: { tool, ok: true } }] };
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/codex.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/adapters/codex/normalize.ts packages/adapters/tests/adapters/codex.test.ts packages/adapters/tests/adapters/fixtures/codex/hook-stdin.sample.json
git commit -m "adapters/codex: record real tool success/failure from exit_code"
```

---

## Task A2: Claude `tool.used` reports real success/failure

**Files:**
- Modify: `packages/adapters/src/adapters/claude/normalize.ts:4-12` (interface) and `:66-67` (tool.used case)
- Modify: `packages/adapters/tests/adapters/fixtures/claude/hook-stdin.sample.json`
- Test: `packages/adapters/tests/adapters/claude.test.ts`

> **Open question (verify during execution, do not guess silently):** the Claude `PostToolUse` `tool_response` failure shape is not in the current fixtures. Claude surfaces tool errors inconsistently across tools; the most reliable cross-tool signal is a truthy `tool_response.is_error` (and some tools use `success: false`). This task codes both and **defaults to `ok: true` when neither is present** — preserving today's behavior for tools with no failure signal. Capture a real failed-tool `PostToolUse` payload (e.g. a Bash command that exits non-zero, or a Read of a missing file) and confirm/adjust the field names before considering this task done; update the fixture in Step 1 to match the real payload.

- [ ] **Step 1: Add a failed-tool fixture**

In `packages/adapters/tests/adapters/fixtures/claude/hook-stdin.sample.json`, add a `PostToolUseFail` key alongside the existing `PostToolUse` (keep `PostToolUse` unchanged):

```json
  "PostToolUseFail": { "session_id": "sess-abc", "transcript_path": "/tmp/t.jsonl", "cwd": "/work", "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_response": { "is_error": true } }
```

- [ ] **Step 2: Write the failing test**

Append to `packages/adapters/tests/adapters/claude.test.ts` (the file already imports `normalizeClaude` and defines `target`):

```ts
test("tool.used reflects tool_response failure: is_error/success:false → fail, else ok", () => {
  const err = normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash", tool_response: { is_error: true } }, target });
  expect(err.events[0]?.payload).toEqual({ tool: "Bash", ok: false, detail: "error" });

  const succ = normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Read", tool_response: { success: false } }, target });
  expect(succ.events[0]?.payload).toEqual({ tool: "Read", ok: false, detail: "error" });

  // No failure signal → default ok (unchanged behavior).
  const ok = normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash", tool_response: { stdout: "hi" } }, target });
  expect(ok.events[0]?.payload).toEqual({ tool: "Bash", ok: true });

  // No tool_response at all → default ok.
  const bare = normalizeClaude({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash" }, target });
  expect(bare.events[0]?.payload).toEqual({ tool: "Bash", ok: true });
});
```

> Note: the **existing** test at `claude.test.ts:55` asserts `{ tool: "Bash", ok: true }` for `raw: { tool_name: "Bash" }` (no `tool_response`). The implementation below keeps that exact output, so that test stays green — do not modify it.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts -t "tool.used reflects tool_response failure"`
Expected: FAIL — current code returns `ok: true` regardless of `tool_response`.

- [ ] **Step 4: Implement**

In `packages/adapters/src/adapters/claude/normalize.ts`, add the field to `ClaudeHookStdin` (lines 4-12):

```ts
  tool_response?: { is_error?: boolean; success?: boolean } & Record<string, unknown>;
```

Replace the `case "tool.used":` (line 66-67):

```ts
    case "tool.used": {
      const tool = typeof raw.tool_name === "string" ? raw.tool_name : "unknown";
      // Claude surfaces tool errors inconsistently; the reliable cross-tool signals
      // are tool_response.is_error (truthy) and tool_response.success === false.
      // Absent either signal we default to ok — never invent a failure we can't see.
      const tr = raw.tool_response;
      const failed = tr != null && (tr.is_error === true || tr.success === false);
      if (failed) return { events: [{ kind: "tool.used", payload: { tool, ok: false, detail: "error" } }] };
      return { events: [{ kind: "tool.used", payload: { tool, ok: true } }] };
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS (including the pre-existing `tool.used carries the tool name` test at line 53-56).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/adapters/claude/normalize.ts packages/adapters/tests/adapters/claude.test.ts packages/adapters/tests/adapters/fixtures/claude/hook-stdin.sample.json
git commit -m "adapters/claude: record real tool success/failure from tool_response"
```

---

## Task A3: Validate `tool.used.ok` type at ingest

**Files:**
- Modify: `packages/protocol/src/validators.ts:117-121`
- Test: `packages/protocol/tests/validators.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/tests/validators.test.ts`:

```ts
test("tool.used accepts ok boolean/absent, rejects non-boolean ok", () => {
  expect(validateKnownPayload("tool.used", { tool: "Bash" })).toEqual({ ok: true });
  expect(validateKnownPayload("tool.used", { tool: "Bash", ok: false, detail: "exit 1" })).toEqual({ ok: true });
  expect(validateKnownPayload("tool.used", { tool: "Bash", ok: "nope" }).ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/tests/validators.test.ts -t "tool.used accepts ok boolean"`
Expected: FAIL — current `tool.used` case only checks `tool`, so `ok: "nope"` passes.

- [ ] **Step 3: Implement**

In `packages/protocol/src/validators.ts`, replace the `case "tool.used":` block (lines 117-121):

```ts
    case "tool.used": {
      if (!isStringNonEmpty(payload.tool))
        return { ok: false, error: "tool.used: tool missing" };
      if ("ok" in payload && payload.ok !== null && typeof payload.ok !== "boolean")
        return { ok: false, error: "tool.used: ok must be boolean|null when present" };
      return { ok: true };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/tests/validators.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/validators.ts packages/protocol/tests/validators.test.ts
git commit -m "protocol: validate tool.used.ok is boolean|null when present"
```

---

# Part B — `compaction` event

## Task B1: Protocol — add the `compaction` event kind

**Files:**
- Modify: `packages/protocol/src/events.ts` (kinds list ~12-24, payloads, event-type aliases, `KnownEvent`)
- Modify: `packages/protocol/src/validators.ts` (new `case`)
- Test: `packages/protocol/tests/events-types.test.ts`, `packages/protocol/tests/validators.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/tests/validators.test.ts`:

```ts
test("compaction validates trigger (manual|auto|null|absent), rejects other strings", () => {
  expect(validateKnownPayload("compaction", {})).toEqual({ ok: true });
  expect(validateKnownPayload("compaction", { trigger: "manual" })).toEqual({ ok: true });
  expect(validateKnownPayload("compaction", { trigger: "auto" })).toEqual({ ok: true });
  expect(validateKnownPayload("compaction", { trigger: null })).toEqual({ ok: true });
  expect(validateKnownPayload("compaction", { trigger: "weird" }).ok).toBe(false);
});
```

Append to `packages/protocol/tests/events-types.test.ts` (this file imports from `../src/events.ts`; match its existing style — if it imports `EVENT_KINDS_ADAPTER`, reuse it, otherwise import it):

```ts
import { EVENT_KINDS_ADAPTER } from "../src/events.ts";
test("compaction is a known adapter event kind", () => {
  expect((EVENT_KINDS_ADAPTER as readonly string[]).includes("compaction")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/protocol/tests/validators.test.ts -t "compaction validates trigger"` then `bun test packages/protocol/tests/events-types.test.ts -t "compaction is a known"`
Expected: both FAIL (`compaction` falls through to the default `{ ok: true }` in the validator so the `"weird"` assertion fails; kind not in list).

- [ ] **Step 3: Implement in `events.ts`**

Add `"compaction"` to `EVENT_KINDS_ADAPTER` (insert after `"prompt.sent"`, before `"session.adapter_attached"`):

```ts
  "prompt.sent",
  "compaction",
  "session.adapter_attached",
```

Add the payload interface (after `PromptSentPayload`, ~line 146):

```ts
// A context compaction happened mid-session (Claude PreCompact). Log-only: the
// fact is queryable from the event log; identity rotation is handled separately by
// SessionStart re-registration (resolve.ts rule 3). `trigger` is the provider's
// cause when known ("manual" = user /compact, "auto" = auto-compaction).
export interface CompactionPayload {
  trigger: "manual" | "auto" | null;
}
```

Add the event-type alias (near the other aliases, after `PromptSentEvent`, ~line 171):

```ts
export type CompactionEvent = EventEnvelope<CompactionPayload> & { kind: "compaction" };
```

Add `CompactionEvent` to the `KnownEvent` union (after `PromptSentEvent`, ~line 188):

```ts
  | PromptSentEvent
  | CompactionEvent
  | AdapterAttachedEvent;
```

- [ ] **Step 4: Implement in `validators.ts`**

Add a `case` in `validateKnownPayload` before the `default:` (after the `session.lost` case, ~line 143):

```ts
    case "compaction": {
      const t = payload.trigger;
      if (t != null && t !== "manual" && t !== "auto")
        return { ok: false, error: "compaction: trigger must be manual|auto|null" };
      return { ok: true };
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/protocol/tests/`
Expected: PASS (all protocol tests).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/validators.ts packages/protocol/tests/events-types.test.ts packages/protocol/tests/validators.test.ts
git commit -m "protocol: add compaction event kind + validator"
```

---

## Task B2: Adapters core — register `compaction` as a manifest point

**Files:**
- Modify: `packages/adapters/src/core/types.ts:8-18`
- Test: `packages/adapters/tests/manifest.test.ts` (or wherever `isManifestPoint` is tested — verify with `grep -rl isManifestPoint packages/adapters/tests`)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/manifest.test.ts` (import `isManifestPoint` from `../src/core/manifest.ts` if not already imported):

```ts
test("compaction is a manifest point", () => {
  expect(isManifestPoint("compaction")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/manifest.test.ts -t "compaction is a manifest point"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/adapters/src/core/types.ts`, add `"compaction"` to `MANIFEST_POINTS` (insert after `"prompt.sent"`, ~line 16):

```ts
  "tool.used",
  "prompt.sent",
  "compaction",
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/core/types.ts packages/adapters/tests/manifest.test.ts
git commit -m "adapters/core: add compaction manifest point"
```

---

## Task B3: Claude `normalize` maps `compaction`

**Files:**
- Modify: `packages/adapters/src/adapters/claude/normalize.ts` (interface + new `case`)
- Test: `packages/adapters/tests/adapters/claude.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/claude.test.ts`:

```ts
test("compaction maps PreCompact trigger; defaults to null when absent", () => {
  expect(normalizeClaude({ point: "compaction", source: "hook-command", raw: { trigger: "manual" }, target }).events[0])
    .toEqual({ kind: "compaction", payload: { trigger: "manual" } });
  expect(normalizeClaude({ point: "compaction", source: "hook-command", raw: { trigger: "auto" }, target }).events[0]?.payload)
    .toEqual({ trigger: "auto" });
  expect(normalizeClaude({ point: "compaction", source: "hook-command", raw: {}, target }).events[0]?.payload)
    .toEqual({ trigger: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts -t "compaction maps PreCompact"`
Expected: FAIL — `compaction` hits the `default:` and returns `{ events: [] }`.

- [ ] **Step 3: Implement**

In `packages/adapters/src/adapters/claude/normalize.ts`, add to `ClaudeHookStdin` (lines 4-12):

```ts
  trigger?: string;
```

Add a `case` before `default:` (after the `tool.used` case, ~line 67):

```ts
    case "compaction": {
      // PreCompact stdin carries trigger: "manual" (user /compact) | "auto".
      const t = raw.trigger;
      return { events: [{ kind: "compaction", payload: { trigger: t === "manual" || t === "auto" ? t : null } }] };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/claude/normalize.ts packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters/claude: normalize compaction from PreCompact"
```

---

## Task B4: Claude capabilities declare `compaction`

**Files:**
- Modify: `packages/adapters/src/adapters/claude/caps.ts:6-33`
- Test: `packages/adapters/tests/adapters/claude.test.ts` (the existing `every fulfilled capability is covered by a source` test at line 9-14 guards this)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/claude.test.ts`:

```ts
test("compaction is a live hook-command capability", () => {
  expect(CLAUDE_CAPABILITIES["compaction"]).toMatchObject({ fulfil: "yes", source: "hook-command", liveness: "live" });
  const covered = new Set(CLAUDE_SOURCES.flatMap((s) => s.points as string[]));
  expect(covered.has("compaction")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts -t "compaction is a live hook-command capability"`
Expected: FAIL — `CLAUDE_CAPABILITIES["compaction"]` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/adapters/src/adapters/claude/caps.ts`, add `"compaction"` to the `hook-command` source `points` array (line 10):

```ts
    points: ["session.registered", "session.linked", "turn.started", "turn.ended", "input.required", "tool.used", "prompt.sent", "compaction"],
```

Add to `CLAUDE_CAPABILITIES` (after the `prompt.sent` entry, ~line 32):

```ts
  "prompt.sent": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "compaction": { fulfil: "yes", source: "hook-command", liveness: "live" },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/claude.test.ts`
Expected: PASS (including the `every fulfilled capability is covered by a source` and conformance tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/claude/caps.ts packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters/claude: declare compaction capability"
```

---

## Task B5: Claude plugin emits a `PreCompact` hook (v1.3.0)

**Files:**
- Modify: `packages/adapters/src/adapters/claude/plugin-files.ts:6` (version) and `:18-65` (HOOKS)
- Test: `packages/adapters/tests/adapters/claude-plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/claude-plugin.test.ts` (the file already has a `file(...)` helper and imports `PLUGIN_FILES`/`PLUGIN_VERSION` — reuse them):

```ts
test("PreCompact hook emits the compaction point (async)", () => {
  const h = JSON.parse(file("hooks/hooks.json").content);
  expect(h.hooks.PreCompact).toBeDefined();
  const cmds = h.hooks.PreCompact[0].hooks;
  expect(cmds[0].async).toBe(true);
  expect(cmds[0].command).toContain("--point=compaction");
});

test("plugin version is 1.3.0", () => {
  expect(PLUGIN_VERSION).toBe("1.3.0");
});
```

- [ ] **Step 2: Update the existing version assertions (they pin 1.2.0)**

The existing test at `claude-plugin.test.ts:46-50` asserts `manifest.version === "1.2.0"` (and line 48 has a literal `"1.2.0"`). Update that test's literals to `"1.3.0"`. Read the test first to get the exact lines; change only the version-string assertions, not the hook-content assertions. Do **not** touch the `SessionStart re-links on clear/compact` test (line 41-43) — the `startup|resume|clear|compact` matcher stays.

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `bun test packages/adapters/tests/adapters/claude-plugin.test.ts -t "PreCompact hook emits"`
Expected: FAIL — no `PreCompact` key in hooks.json.

- [ ] **Step 4: Implement**

In `packages/adapters/src/adapters/claude/plugin-files.ts`, bump the version (line 6):

```ts
export const PLUGIN_VERSION = "1.3.0";
```

Add a `PreCompact` block to `HOOKS.hooks` (insert after the `PostToolUse` block, before the closing of `hooks`, ~line 63). PreCompact fires *before* compaction; recording it is the queryable fact. (SessionStart's `compact` matcher continues to handle native-id rotation after compaction — unchanged.)

```ts
    PreCompact: [
      {
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=compaction` },
        ],
      },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/adapters/tests/adapters/claude-plugin.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full adapters suite (catch drift/conformance fallout)**

Run: `bun test packages/adapters/`
Expected: PASS. (The `status reports drift` and install tests use `PLUGIN_VERSION` via `ADAPTER_VERSION`, which is unchanged at `"1"`; the version bump is the manifest `PLUGIN_VERSION` only — confirm no install test hardcodes `"1.2.0"` with `grep -rn "1.2.0" packages/adapters/tests` and update any that do.)

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/adapters/claude/plugin-files.ts packages/adapters/tests/adapters/claude-plugin.test.ts
git commit -m "adapters/claude: emit PreCompact compaction hook (plugin v1.3.0)"
```

---

## Task B6: Store projection — `compaction` is explicit log-only

**Files:**
- Modify: `packages/store/src/project.ts:4-58` (the `applyEventToProjection` switch)
- Test: `packages/store/tests/project.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/store/tests/project.test.ts` (uses the file's existing `freshDb()`, `sid`, and `startedEvent()` helpers):

```ts
test("compaction is log-only: no projection side effects, session row untouched", () => {
  const db = freshDb();
  applyEventToProjection(db, startedEvent());
  const before = db.query<any, []>(`SELECT * FROM sessions WHERE session_id='${sid}'`).get();
  applyEventToProjection(db, {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2R",
    ts: "2026-05-28T12:01:00.000Z",
    session_id: sid,
    kind: "compaction",
    version: 1,
    host: "macbook.local",
    payload: { trigger: "manual" },
  });
  const after = db.query<any, []>(`SELECT * FROM sessions WHERE session_id='${sid}'`).get();
  expect(after).toEqual(before); // projection unchanged — compaction only lives in the event log
});
```

- [ ] **Step 2: Run test to verify it passes (yes — confirm current behavior first)**

Run: `bun test packages/store/tests/project.test.ts -t "compaction is log-only"`
Expected: PASS already — `compaction` currently hits the `default:` (no-op). This test pins the contract so a future `case` that accidentally mutates the projection is caught.

- [ ] **Step 3: Make the log-only intent explicit in code**

In `packages/store/src/project.ts`, change the `prompt.sent` comment line (line 53) to name both log-only known kinds:

```ts
    // prompt.sent and compaction are known but log-only: stored in the event
    // log, no projection effect. (A compaction_count column is a deferred option.)
    default:
      // Unknown kinds are stored in events but do not touch the projection.
      return;
```

> No `case "compaction"` is added: routing it through `default` is the log-only behavior, and the comment documents that it is intentional, not an oversight. The Step-1 test guards the contract.

- [ ] **Step 4: Run test to verify it still passes**

Run: `bun test packages/store/tests/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/project.ts packages/store/tests/project.test.ts
git commit -m "store: document compaction as log-only in projection"
```

---

## Task B7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire test suite**

Run: `bun test`
Expected: PASS across all packages. If anything in `hub`/`cli`/`tui` references the adapter event set or plugin version and breaks, fix the reference (do not weaken the new tests).

- [ ] **Step 2: Confirm no stray `1.2.0` literals remain**

Run: `grep -rn "1\.2\.0" packages | grep -v node_modules`
Expected: no results (or only intentional historical references in design docs — not in `packages/`). Fix any leftover test/code literals.

- [ ] **Step 3: Final commit (if Step 1/2 required fixes)**

```bash
git add -A
git commit -m "tests: align suite with tool-failure + compaction additions"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** Both approved design sections are covered — tool-failure fidelity (Tasks A1 claude-was-A2/codex-A1, A3 validator) and `compaction` event (B1 protocol, B2 manifest point, B3 normalize, B4 caps, B5 plugin hook, B6 projection log-only). The "open question" on Claude's `tool_response` failure shape is explicitly flagged in Task A2 with a verification step, not silently assumed.
- **Type consistency:** `CompactionPayload.trigger` is `"manual" | "auto" | null` everywhere (events.ts, validator, normalize, test). `tool.used` payload adds `ok`/`detail` consistent with the existing `ToolUsedPayload` (`ok?: boolean | null`, `detail?: string | null`) in `events.ts:137-141` — no new fields invented. `PLUGIN_VERSION` (`1.3.0`) is distinct from `ADAPTER_VERSION` (`"1"`, unchanged) per `install.ts`.
- **No placeholders:** every code step shows the actual code; every run step shows the command and expected result.
- **Migration-free:** confirmed — no `@agmux/store` schema change; `compaction` routes through the projection `default` (log-only) and `tool.used` reuses existing columns.

## Deferred (out of scope — recommend filing as backlog follow-ups)

- `PreToolUse` → `tool-call`/`tool-result` split (tool latency, in-flight signal) — omnigent captures this; agmux currently only wires `PostToolUse`.
- Codex/pi compaction hooks — neither exposes a clean PreCompact equivalent today; revisit when their extension surfaces add one.
- `compaction_count` (and tool-failure counts) projection column + `session_activity` surfacing — needs a store migration; the event-log truth lands now, projection rollups can follow.
- Output/text-delta streaming capture — explicitly a non-goal of the native-first spec; unchanged deferral.
- **Close the pitch:** recommend marking `docs/backlog/01-native-hook-event-capture.md` as delivered-by-native-first, with these deltas tracked as the residual items.
