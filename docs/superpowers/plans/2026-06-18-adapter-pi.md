# PI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third concrete agmux adapter for the PI coding agent (`pi`), capturing session lifecycle, turns, tools, prompts, and live token usage via an auto-discovered PI extension.

**Architecture:** PI loads TypeScript extensions from `<configDir>/extensions/`. The adapter ships an embedded extension file whose `pi.on(...)` handlers spawn `agmux emit --from=pi` as detached, fire-and-forget child processes. Install is pure filesystem (write/delete the extension file, Claude-style). Identity comes from the session-file UUID carried on the emit's stdin (Codex pattern). Usage arrives live in the `message_end` event — no transcript tailing.

**Tech Stack:** TypeScript on Bun, `bun:test`, Bun workspaces. New package dir `packages/adapters/src/adapters/pi/` mirrors the existing `codex/` module file-for-file.

**Spec:** [`docs/superpowers/specs/2026-06-18-adapter-pi-design.md`](../specs/2026-06-18-adapter-pi-design.md)

---

## File Structure

**Create (adapter module):**
- `packages/adapters/src/adapters/pi/caps.ts` — `PI_SOURCES`, `PI_CAPABILITIES`
- `packages/adapters/src/adapters/pi/resume.ts` — `piResumePlan`
- `packages/adapters/src/adapters/pi/extension-files.ts` — embedded extension payload + `EXTENSION_FILES`
- `packages/adapters/src/adapters/pi/normalize.ts` — `normalizePi`
- `packages/adapters/src/adapters/pi/install.ts` — `resolveConfigDir`, `piInstall`/`piUninstall`/`piStatus`, `ADAPTER_VERSION`
- `packages/adapters/src/adapters/pi/index.ts` — assemble `piAdapter`

**Create (tests + fixture):**
- `packages/adapters/tests/adapters/pi.test.ts`
- `packages/adapters/tests/adapters/fixtures/pi/hook-stdin.sample.json`

**Modify (framework wiring):**
- `packages/protocol/src/session.ts:7` — `AgentKind` += `"pi"`
- `packages/wrapper/src/profile.ts:19-22` — `asAgentKind` accepts `"pi"`
- `packages/cli/src/parse-run.ts:24,27-29,108-117` — `ParsedRun` union, `parseKind`, basename heuristic, error messages
- `packages/adapters/src/adapters/index.ts` — register `piAdapter`
- `packages/cli/tests/parse-run.test.ts` — add `pi` cases
- `packages/adapters/tests/registry-wiring.test.ts` — add `pi` case
- `README.md` — `pi` profile example + capability note

---

### Task 1: Add `"pi"` to `AgentKind` and accept it in wrapper profiles

**Files:**
- Modify: `packages/protocol/src/session.ts:7`
- Modify: `packages/wrapper/src/profile.ts:19-22`
- Test: `packages/wrapper/tests/profile.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/wrapper/tests/profile.test.ts` (after the existing `rejects unknown agent_kind` test):

```ts
test("parseConfig accepts agent_kind 'pi'", () => {
  const cfg = parseConfig(`[profiles.pi-default]\nagent_kind = "pi"\ncommand = "pi"\n`);
  expect(cfg.profiles["pi-default"]?.agent_kind).toBe("pi");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/wrapper/tests/profile.test.ts`
Expected: FAIL — `parseConfig` throws `agent_kind must be 'claude' or 'codex'`.

- [ ] **Step 3: Implement the changes**

In `packages/protocol/src/session.ts:7`:

```ts
export type AgentKind = "claude" | "codex" | "pi";
```

In `packages/wrapper/src/profile.ts:19-22`:

```ts
function asAgentKind(v: unknown): AgentKind {
  if (v === "claude" || v === "codex" || v === "pi") return v;
  throw new Error(`profile: agent_kind must be 'claude', 'codex', or 'pi', got ${JSON.stringify(v)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/wrapper/tests/profile.test.ts`
Expected: PASS (all tests, including the existing `rejects unknown agent_kind` which still throws on `"magic"`).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/session.ts packages/wrapper/src/profile.ts packages/wrapper/tests/profile.test.ts
git commit -m "adapters: add 'pi' to AgentKind + accept in profiles"
```

---

### Task 2: Accept `pi` in the CLI `agmux run` parser

**Files:**
- Modify: `packages/cli/src/parse-run.ts:24,27-29,108-117`
- Test: `packages/cli/tests/parse-run.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/tests/parse-run.test.ts` (after the `basename 'codex' detects kind` test):

```ts
test("inline: basename 'pi' detects kind", () => {
  expect(parseRunArgs(["pi", "--session", "abc"]))
    .toEqual({ kind: "inline", agent_kind: "pi", command: "pi", args: ["--session", "abc"], placement: "inherit", detach: false, wrapped: false });
});

test("inline: --kind=pi override", () => {
  expect(parseRunArgs(["--kind=pi", "/opt/pi-rc1"]))
    .toEqual({ kind: "inline", agent_kind: "pi", command: "/opt/pi-rc1", args: [], placement: "inherit", detach: false, wrapped: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/parse-run.test.ts`
Expected: FAIL — `--kind=pi` returns `{ kind: "error" }`, and basename `pi` is not detected.

- [ ] **Step 3: Implement the changes**

In `packages/cli/src/parse-run.ts`, line 24 — extend the inline union member:

```ts
  | { kind: "inline"; agent_kind: "claude" | "codex" | "pi"; command: string; args: string[]; placement: Placement; detach: boolean; wrapped: boolean }
```

Lines 27-29 — extend `parseKind`:

```ts
function parseKind(v: string): "claude" | "codex" | "pi" | null {
  return v === "claude" || v === "codex" || v === "pi" ? v : null;
}
```

Update the two `--kind` error messages (the `a === "--kind"` branch and the `a.startsWith("--kind=")` branch) from `'claude' or 'codex'` to:

```ts
        return { kind: "error", message: `--kind must be 'claude', 'codex', or 'pi'` };
```

Lines 108-117 — extend the basename heuristic and the typed local:

```ts
  const detected: "claude" | "codex" | "pi" | undefined =
    basename === "claude" ? "claude" :
    basename === "codex" ? "codex" :
    basename === "pi" ? "pi" :
    undefined;
  const agent_kind = kindFlag ?? detected;
  if (!agent_kind) {
    return {
      kind: "error",
      message: `agmux run: cannot infer agent_kind from '${basename}'. Use --kind=claude, --kind=codex, or --kind=pi.`,
    };
  }
```

Also update the `kindFlag` local declaration type (line 33):

```ts
  let kindFlag: "claude" | "codex" | "pi" | undefined;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/parse-run.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parse-run.ts packages/cli/tests/parse-run.test.ts
git commit -m "adapters: accept 'pi' in agmux run parser"
```

---

### Task 3: PI capability map (`caps.ts`)

**Files:**
- Create: `packages/adapters/src/adapters/pi/caps.ts`
- Test: `packages/adapters/tests/adapters/pi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/tests/adapters/pi.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/pi/caps.ts`.

- [ ] **Step 3: Implement `caps.ts`**

Create `packages/adapters/src/adapters/pi/caps.ts`:

```ts
import type { CapabilityMap } from "@agmux/protocol";
import type { CapabilitySource } from "../../core/types.ts";

// One event-triggered source. PI's extension IS the command runner (each handler
// spawns `agmux emit`), so the existing "hook-command" source type fits with no
// protocol change. Unlike claude/codex, usage arrives LIVE in the message_end
// event payload — no transcript-delta read, no cursor file.
export const PI_SOURCES: CapabilitySource[] = [
  {
    type: "hook-command",
    activation: "event-triggered",
    points: ["session.registered", "session.linked", "turn.started", "turn.ended", "tool.used", "prompt.sent", "usage.reported"],
  },
];

// Finest-grain descriptors (spec §4). input.required is OMITTED: PI exposes no
// native permission/idle signal, so the "waiting" status is never surfaced
// (honest partial coverage). input.received is omitted too — fulfilled implicitly
// by the next turn.started (cf. claude/codex).
export const PI_CAPABILITIES: CapabilityMap = {
  "session.registered": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "session.linked": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.ended": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "tool.used": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "prompt.sent": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "usage.reported": { fulfil: "yes", source: "hook-command", liveness: "live" },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/pi/caps.ts packages/adapters/tests/adapters/pi.test.ts
git commit -m "adapters: pi capability map + sources"
```

---

### Task 4: PI resume plan (`resume.ts`)

**Files:**
- Create: `packages/adapters/src/adapters/pi/resume.ts`
- Test: `packages/adapters/tests/adapters/pi.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/pi.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/pi/resume.ts`.

- [ ] **Step 3: Implement `resume.ts`**

Create `packages/adapters/src/adapters/pi/resume.ts`:

```ts
import type { ResumeContext, ResumePlan } from "../../core/types.ts";

// `pi --session <id>` resumes by partial UUID (verified: `pi --session <path|id>`).
// It is a FLAG, not a subcommand — the divergence from codex's `codex resume <id>`
// and the parallel to claude's `--resume <id>`. Without a native id, fall back to
// a fresh relaunch.
export function piResumePlan(ctx: ResumeContext): ResumePlan {
  if (!ctx.nativeSessionId) return { resumable: false };
  return {
    resumable: true,
    argv: [ctx.command, "--session", ctx.nativeSessionId, ...ctx.args],
    cwd: ctx.cwd,
    env: ctx.env,
    nativeSessionId: ctx.nativeSessionId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/pi/resume.ts packages/adapters/tests/adapters/pi.test.ts
git commit -m "adapters: pi resumePlan (pi --session <id>)"
```

---

### Task 5: Embedded PI extension payload (`extension-files.ts`)

**Files:**
- Create: `packages/adapters/src/adapters/pi/extension-files.ts`
- Test: `packages/adapters/tests/adapters/pi.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/pi.test.ts`:

```ts
import { EXTENSION_FILES, EXTENSION_FILENAME, PLUGIN_VERSION } from "../../src/adapters/pi/extension-files.ts";

test("extension payload is a single auto-discoverable agmux.ts", () => {
  expect(EXTENSION_FILES).toHaveLength(1);
  expect(EXTENSION_FILES[0]!.path).toBe(EXTENSION_FILENAME);
  expect(EXTENSION_FILENAME).toBe("agmux.ts");
});

test("extension source carries the version marker, a default export, and emits --from=pi for each point", () => {
  const src = EXTENSION_FILES[0]!.content;
  expect(src).toContain(`agmux-pi-extension v${PLUGIN_VERSION}`);
  expect(src).toContain("export default function");
  expect(src).toContain("--from=pi");
  for (const p of ["session.registered", "session.linked", "turn.started", "turn.ended", "tool.used", "prompt.sent", "usage.reported"]) {
    expect(src).toContain(`--point=${p}`);
  }
  // Registers a handler for every PI event we consume.
  for (const ev of ["session_start", "input", "agent_start", "tool_result", "message_end", "agent_end"]) {
    expect(src).toContain(`pi.on("${ev}"`);
  }
  // Fire-and-forget: detached spawn, unref, never awaited.
  expect(src).toContain("detached: true");
  expect(src).toContain(".unref()");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/pi/extension-files.ts`.

- [ ] **Step 3: Implement `extension-files.ts`**

Create `packages/adapters/src/adapters/pi/extension-files.ts`. The `EXTENSION_SOURCE` is a template string (PI loads it via jiti at runtime — it is NOT typechecked by this package's `tsc`):

```ts
// The agmux PI extension payload, embedded as a string (cf. codex/plugin-files.ts,
// claude/plugin-files.ts). install() WRITES this to <configDir>/extensions/agmux.ts,
// which PI auto-discovers. Embedded as code (not an on-disk data file) so the
// adapter behaves identically from source and from a `bun build --compile` binary.

export const PLUGIN_VERSION = "1.0.0";
export const EXTENSION_FILENAME = "agmux.ts";
export const VERSION_MARKER = `agmux-pi-extension v${PLUGIN_VERSION}`;

// Each handler spawns `agmux emit` DETACHED and never awaits — telemetry must
// never block PI's event loop or alter its behavior (handlers return nothing).
// The child inherits process.env, so AGMUX_SESSION_ID / AGMUX_PROFILE /
// AGMUX_HUB_URL / TMUX_PANE (when wrapper-launched) flow through automatically.
const EXTENSION_SOURCE = `// ${VERSION_MARKER}
// agmux session telemetry for PI — auto-discovered from <configDir>/extensions/.
// DO NOT EDIT: managed by \`agmux adapter install\`.
import { spawn } from "node:child_process";
import * as path from "node:path";

function agmuxBin() {
  return process.env.AGMUX_BIN || "agmux";
}

// Native id = the UUID after the last "_" in the session filename
// (<ts>_<uuid>.jsonl); null for ephemeral/-p sessions (getSessionFile() === null).
function sessionId(ctx) {
  const file = ctx && ctx.sessionManager && ctx.sessionManager.getSessionFile
    ? ctx.sessionManager.getSessionFile() : null;
  if (!file) return null;
  const base = path.basename(String(file)).replace(/\\.jsonl$/, "");
  const idx = base.lastIndexOf("_");
  return idx >= 0 ? base.slice(idx + 1) : base;
}

function emit(args, payload) {
  try {
    const child = spawn(agmuxBin(), ["emit", "--from=pi"].concat(args), {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    child.on("error", function () {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  } catch (_e) {
    // telemetry must never break the agent
  }
}

function emitPoint(point, ctx, extra) {
  emit(["--source=hook-command", "--point=" + point], Object.assign({ session_id: sessionId(ctx) }, extra));
}

export default function (pi) {
  pi.on("session_start", function (event, ctx) {
    var sid = sessionId(ctx);
    emit(["--source=hook-command", "--point=session.registered"], { session_id: sid, cwd: (ctx && ctx.cwd) || null, pid: process.pid });
    emit(["--attach"], { session_id: sid });
    if (event && (event.reason === "resume" || event.reason === "fork")) {
      emit(["--source=hook-command", "--point=session.linked"], { session_id: sid });
    }
  });

  pi.on("input", function (event, ctx) {
    var text = event && typeof event.text === "string" ? event.text
      : (event && typeof event.input === "string" ? event.input : "");
    emitPoint("prompt.sent", ctx, { prompt: text });
  });

  pi.on("agent_start", function (_event, ctx) {
    emitPoint("turn.started", ctx, {});
  });

  pi.on("tool_result", function (event, ctx) {
    emitPoint("tool.used", ctx, { tool_name: (event && event.toolName) || null, is_error: !!(event && event.isError) });
  });

  pi.on("message_end", function (event, ctx) {
    var msg = event && event.message;
    if (!msg || !msg.usage) return;
    emitPoint("usage.reported", ctx, { usage: msg.usage, model: msg.model || null, message_id: msg.id || null });
  });

  pi.on("agent_end", function (_event, ctx) {
    emitPoint("turn.ended", ctx, {});
  });
}
`;

export interface ExtensionFile {
  path: string;  // relative to the extensions/ dir
  content: string;
  mode: number;
}

export const EXTENSION_FILES: ExtensionFile[] = [
  { path: EXTENSION_FILENAME, content: EXTENSION_SOURCE, mode: 0o644 },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/pi/extension-files.ts packages/adapters/tests/adapters/pi.test.ts
git commit -m "adapters: embedded pi extension payload"
```

---

### Task 6: `normalize.ts` + fixture

**Files:**
- Create: `packages/adapters/src/adapters/pi/normalize.ts`
- Create: `packages/adapters/tests/adapters/fixtures/pi/hook-stdin.sample.json`
- Test: `packages/adapters/tests/adapters/pi.test.ts` (append)

- [ ] **Step 1: Write the fixture**

Create `packages/adapters/tests/adapters/fixtures/pi/hook-stdin.sample.json` (the per-point payloads the extension writes to `agmux emit` stdin):

```json
{
  "session_start": { "session_id": "019e6415-f214-72d2-8352-afd93f03133c", "cwd": "/work", "pid": 4242, "reason": "startup" },
  "session_resume": { "session_id": "019e6415-f214-72d2-8352-afd93f03133c", "reason": "resume" },
  "input": { "session_id": "019e6415-f214-72d2-8352-afd93f03133c", "prompt": "refactor the parser" },
  "tool_result": { "session_id": "019e6415-f214-72d2-8352-afd93f03133c", "tool_name": "bash", "is_error": false },
  "message_end": { "session_id": "019e6415-f214-72d2-8352-afd93f03133c", "model": "gpt-5.5", "message_id": "m-1", "usage": { "input_tokens": 1200, "output_tokens": 340, "cache_read_tokens": 800, "cache_write_tokens": 0, "reasoning_output_tokens": 64, "total_tokens": 1604, "model_context_window": 258400 } }
}
```

- [ ] **Step 2: Write the failing test**

Append to `packages/adapters/tests/adapters/pi.test.ts`:

```ts
import { normalizePi } from "../../src/adapters/pi/normalize.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";

const target = { agentKind: "pi" as const, profile: null };
const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pi", "hook-stdin.sample.json");
const SAMPLE = JSON.parse(fs.readFileSync(FX, "utf8"));

test("session.registered builds the native lifecycle root from stdin + env", () => {
  const out = normalizePi({
    point: "session.registered", source: "hook-command",
    raw: SAMPLE.session_start, target,
    env: { TMUX_PANE: "%4", AGMUX_PROFILE: "work", PI_VERSION: "0.75.5" },
  });
  expect(out.events).toHaveLength(1);
  const p = out.events[0]!.payload as any;
  expect(out.events[0]!.kind).toBe("session.registered");
  expect(p.native_session_id).toBe("019e6415-f214-72d2-8352-afd93f03133c");
  expect(p.agent_kind).toBe("pi");
  expect(p.pid).toBe(4242);
  expect(p.cwd).toBe("/work");
  expect(p.tmux_pane).toBe("%4");
  expect(p.profile).toBe("work");
  expect(p.agent_version).toBe("0.75.5");
  expect(p.parent).toBeNull();
});

test("session.registered falls back to AGMUX_AGENT_PID when payload pid is absent", () => {
  const out = normalizePi({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-x" }, target, env: { AGMUX_AGENT_PID: "5151" },
  });
  expect((out.events[0]!.payload as any).pid).toBe(5151);
});

test("session.registered/linked are no-ops without a session_id", () => {
  expect(normalizePi({ point: "session.registered", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
  expect(normalizePi({ point: "session.linked", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
});

test("session.linked maps native session id from stdin", () => {
  const out = normalizePi({ point: "session.linked", source: "hook-command", raw: SAMPLE.session_resume, target });
  expect(out.events).toEqual([{ kind: "session.linked", payload: { native_session_id: "019e6415-f214-72d2-8352-afd93f03133c" } }]);
});

test("turn.started / turn.ended map to canonical events", () => {
  expect(normalizePi({ point: "turn.started", source: "hook-command", raw: {}, target }).events[0]?.kind).toBe("turn.started");
  expect(normalizePi({ point: "turn.ended", source: "hook-command", raw: {}, target }).events[0]).toEqual({ kind: "turn.ended", payload: { reason: null } });
});

test("prompt.sent is redacted (chars only); tool.used carries the tool name and ok", () => {
  expect(normalizePi({ point: "prompt.sent", source: "hook-command", raw: SAMPLE.input, target }).events[0]?.payload).toEqual({ chars: 19, redacted: true });
  expect(normalizePi({ point: "tool.used", source: "hook-command", raw: SAMPLE.tool_result, target }).events[0]?.payload).toEqual({ tool: "bash", ok: true });
  expect(normalizePi({ point: "tool.used", source: "hook-command", raw: { tool_name: "bash", is_error: true }, target }).events[0]?.payload).toEqual({ tool: "bash", ok: false });
});

test("usage.reported maps message_end usage into a per-message delta with a stable dedup key", () => {
  const out = normalizePi({ point: "usage.reported", source: "hook-command", raw: SAMPLE.message_end, target });
  expect(out.events).toHaveLength(1);
  expect(out.events[0]).toMatchObject({
    kind: "usage.reported",
    payload: {
      cumulative: false, source: "hook-command", model: "gpt-5.5",
      input_tokens: 1200, output_tokens: 340, cache_read_tokens: 800, cache_write_tokens: 0,
      reasoning_output_tokens: 64, total_tokens: 1604, model_context_window: 258400,
    },
  });
  expect(out.events[0]!.dedup_key).toBe("pi:hook-command:019e6415-f214-72d2-8352-afd93f03133c:m-1");
});

test("usage.reported is a no-op when no usage object is present", () => {
  expect(normalizePi({ point: "usage.reported", source: "hook-command", raw: { session_id: "x" }, target }).events).toHaveLength(0);
});

test("usage.reported tolerates camelCase token field variants (defensive mapping)", () => {
  const out = normalizePi({ point: "usage.reported", source: "hook-command",
    raw: { session_id: "s", message_id: "m2", usage: { inputTokens: 5, outputTokens: 7 } }, target });
  expect(out.events[0]!.payload).toMatchObject({ input_tokens: 5, output_tokens: 7, total_tokens: null });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/pi/normalize.ts`.

- [ ] **Step 4: Implement `normalize.ts`**

Create `packages/adapters/src/adapters/pi/normalize.ts`:

```ts
import type { NormalizeInput, NormalizeOutput } from "../../core/types.ts";

// The JSON the embedded extension writes to `agmux emit` stdin (extension-files.ts).
interface PiHookStdin {
  session_id?: string;
  cwd?: string;
  pid?: number;
  reason?: string;
  prompt?: string;
  tool_name?: string | null;
  is_error?: boolean;
  model?: string | null;
  message_id?: string | null;
  usage?: Record<string, unknown>;
}

export function normalizePi(input: NormalizeInput): NormalizeOutput {
  const raw = (input.raw ?? {}) as PiHookStdin & Record<string, unknown>;
  // No nesting guard (cf. codex): PI exports no native session-id env var to
  // cross-check, so nested runs self-register under their own UUID (spec §5).
  switch (input.point) {
    case "session.registered": {
      if (!raw.session_id) return { events: [] };
      const env = input.env ?? {};
      const fromPayload = typeof raw.pid === "number" ? raw.pid : NaN;
      const fromEnv = env.AGMUX_AGENT_PID != null ? Number(env.AGMUX_AGENT_PID) : NaN;
      const pidNum = Number.isInteger(fromPayload) ? fromPayload : fromEnv;
      return { events: [{
        kind: "session.registered",
        payload: {
          native_session_id: raw.session_id,
          agent_kind: "pi",
          pid: Number.isInteger(pidNum) ? pidNum : null,
          cwd: raw.cwd ?? env.PWD ?? null,
          tmux_session: null,
          tmux_window: null,
          tmux_pane: env.TMUX_PANE ?? null,
          profile: env.AGMUX_PROFILE ?? null,
          agent_version: env.PI_VERSION ?? null,
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
    case "prompt.sent":
      return { events: [{ kind: "prompt.sent", payload: { chars: typeof raw.prompt === "string" ? raw.prompt.length : null, redacted: true } }] };
    case "tool.used":
      return { events: [{ kind: "tool.used", payload: { tool: typeof raw.tool_name === "string" ? raw.tool_name : "unknown", ok: raw.is_error !== true } }] };
    case "usage.reported":
      return normalizeUsage(raw);
    default:
      return { events: [] };
  }
}

// Read the first numeric value among the candidate keys; null if none present.
// Tolerates PI's exact usage field names being snake_case OR camelCase (the
// precise shape is confirmed only at live verification — spec §8.1).
function num(o: Record<string, unknown> | undefined, ...keys: string[]): number | null {
  if (!o) return null;
  for (const k of keys) { const v = o[k]; if (typeof v === "number") return v; }
  return null;
}

function normalizeUsage(raw: PiHookStdin): NormalizeOutput {
  const u = raw.usage;
  if (!u) return { events: [] };
  const nativeId = raw.session_id ?? "unknown";
  const msgId = raw.message_id ?? "0";
  return { events: [{
    kind: "usage.reported",
    payload: {
      cumulative: false,
      source: "hook-command",
      model: raw.model ?? null,
      input_tokens: num(u, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"),
      output_tokens: num(u, "output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
      cache_read_tokens: num(u, "cache_read_tokens", "cacheReadTokens", "cached_input_tokens", "cachedInputTokens"),
      cache_write_tokens: num(u, "cache_write_tokens", "cacheWriteTokens", "cache_creation_input_tokens", "cacheCreationInputTokens"),
      reasoning_output_tokens: num(u, "reasoning_output_tokens", "reasoningOutputTokens", "reasoning_tokens", "reasoningTokens"),
      total_tokens: num(u, "total_tokens", "totalTokens"),
      model_context_window: num(u, "model_context_window", "modelContextWindow", "context_window", "contextWindow"),
      rate_limit: null,
      turn_id: null,
      as_of: null,
    },
    dedup_key: `pi:hook-command:${nativeId}:${msgId}`,
  }] };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: PASS (all normalize tests; note `cache_write_tokens: 0` maps through because `0` is a number).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/adapters/pi/normalize.ts packages/adapters/tests/adapters/fixtures/pi/hook-stdin.sample.json packages/adapters/tests/adapters/pi.test.ts
git commit -m "adapters: pi normalize + stdin fixture"
```

---

### Task 7: `install.ts` (filesystem extension drop)

**Files:**
- Create: `packages/adapters/src/adapters/pi/install.ts`
- Test: `packages/adapters/tests/adapters/pi.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/pi.test.ts`:

```ts
import { resolveConfigDir, extensionsDir, piInstall, piUninstall, piStatus, ADAPTER_VERSION } from "../../src/adapters/pi/install.ts";
import * as os from "node:os";

function tmpCfg(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-pi-cfg-")); }
function tmpState(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-pi-state-")); }

const ictx = (configDir: string | undefined, stateDir: string, profile: string | null = null, override: string | null = null) => ({
  agentKind: "pi" as const, profile,
  profileEnv: (configDir ? { PI_CODING_AGENT_DIR: configDir } : {}) as Record<string, string>,
  agmuxEmitPath: "/abs/agmux emit", stateDir,
  ...(override ? { configDirOverride: override } : {}),
});

test("resolveConfigDir: explicit override > profileEnv PI_CODING_AGENT_DIR > default ~/.pi/agent", () => {
  expect(resolveConfigDir(ictx("/cfg", "/s"))).toBe("/cfg");
  expect(resolveConfigDir(ictx("/cfg", "/s", null, "/override"))).toBe("/override");
  expect(resolveConfigDir(ictx(undefined, "/s")).endsWith("/.pi/agent")).toBe(true);
});

test("install writes agmux.ts into <configDir>/extensions; status flips; uninstall reverses", () => {
  const cfg = tmpCfg();
  const ctx = ictx(cfg, tmpState(), "work");
  expect(piStatus(ctx).installed).toBe(false);

  const rec = piInstall(ctx);
  expect(rec).toMatchObject({ agentKind: "pi", profile: "work", adapterVersion: ADAPTER_VERSION, isolationMode: "config-dir" });
  expect(fs.existsSync(path.join(extensionsDir(cfg), "agmux.ts"))).toBe(true);
  expect(piStatus(ctx)).toMatchObject({ installed: true, version: ADAPTER_VERSION, drift: false, runtimeGate: "hook-trust" });

  piUninstall(ctx, rec);
  expect(piStatus(ctx).installed).toBe(false);
  // Uninstall removes only the file, not the extensions dir (may hold others).
  expect(fs.existsSync(extensionsDir(cfg))).toBe(true);
});

test("status reports drift when the installed marker version differs from the payload", () => {
  const cfg = tmpCfg();
  const ctx = ictx(cfg, tmpState());
  piInstall(ctx);
  const file = path.join(extensionsDir(cfg), "agmux.ts");
  fs.writeFileSync(file, "// agmux-pi-extension v0.0.1-stale\n");
  expect(piStatus(ctx).drift).toBe(true);
});

test("separate PI_CODING_AGENT_DIR dirs install independently (profile isolation)", () => {
  const state = tmpState();
  const cfgA = tmpCfg();
  const cfgB = tmpCfg();
  piInstall(ictx(cfgA, state));
  expect(piStatus(ictx(cfgA, state)).installed).toBe(true);
  expect(piStatus(ictx(cfgB, state)).installed).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/pi/install.ts`.

- [ ] **Step 3: Implement `install.ts`**

Create `packages/adapters/src/adapters/pi/install.ts`:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InstallContext, InstallRecord, InstallStatus } from "../../core/types.ts";
import { PI_CAPABILITIES } from "./caps.ts";
import { EXTENSION_FILES, EXTENSION_FILENAME, PLUGIN_VERSION } from "./extension-files.ts";

export const ADAPTER_VERSION = "1";

// Install model (spec §2): drop the embedded extension into <configDir>/extensions/,
// which PI auto-discovers — no settings.json edit, no marketplace, no `pi` binary.
// Pure filesystem, fully reversible. Mirrors Claude's skills-dir model.

// config-dir isolation (spec §1): explicit CLI override > profile's
// PI_CODING_AGENT_DIR > default ~/.pi/agent. The PI analogue of CLAUDE_CONFIG_DIR
// / CODEX_HOME.
export function resolveConfigDir(ctx: InstallContext): string {
  return ctx.configDirOverride ?? ctx.profileEnv.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function extensionsDir(configDir: string): string {
  return path.join(configDir, "extensions");
}

function extensionPath(configDir: string): string {
  return path.join(extensionsDir(configDir), EXTENSION_FILENAME);
}

// Read the version stamped in the extension's marker line (the analogue of
// reading plugin.json's version). null = not installed / unreadable.
function readInstalledVersion(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 200);
    const m = head.match(/agmux-pi-extension v(\S+)/);
    return m ? m[1]! : null;
  } catch { return null; }
}

export function piInstall(ctx: InstallContext): InstallRecord {
  const configDir = resolveConfigDir(ctx);
  const dir = extensionsDir(configDir);
  for (const f of EXTENSION_FILES) {
    const target = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, { mode: f.mode });
  }
  return {
    agentKind: "pi",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: PI_CAPABILITIES,
    artifacts: [{ kind: "file", path: extensionPath(configDir), detail: "pi extension agmux.ts" }],
  };
}

export function piUninstall(_ctx: InstallContext, record: InstallRecord): void {
  // Remove only the extension file — never the extensions/ dir, which may hold
  // user/other-profile extensions.
  for (const a of record.artifacts) {
    if (a.kind === "file") fs.rmSync(a.path, { force: true });
  }
}

export function piStatus(ctx: InstallContext): InstallStatus {
  const file = extensionPath(resolveConfigDir(ctx));
  const installedVersion = readInstalledVersion(file);
  const installed = installedVersion !== null;
  const drift = installed && installedVersion !== PLUGIN_VERSION;
  // Auto-load may still be gated by a per-extension trust prompt at session start
  // (spec §8.3); kept until a live session proves the extension loads ungated.
  return { installed, version: installed ? ADAPTER_VERSION : null, drift, runtimeGate: "hook-trust" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: PASS (all install tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/pi/install.ts packages/adapters/tests/adapters/pi.test.ts
git commit -m "adapters: pi filesystem install/uninstall/status"
```

---

### Task 8: Assemble `piAdapter` (`index.ts`) + conformance

**Files:**
- Create: `packages/adapters/src/adapters/pi/index.ts`
- Test: `packages/adapters/tests/adapters/pi.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/adapters/pi.test.ts`:

```ts
import { piAdapter } from "../../src/adapters/pi/index.ts";
import { assertAdapterConformance } from "../../src/core/conformance.ts";

test("the piAdapter exposes the expected shape", () => {
  expect(piAdapter.agentKind).toBe("pi");
  expect(piAdapter.sources({} as any).length).toBe(1);
  expect(Object.keys(piAdapter.capabilities({} as any))).toContain("usage.reported");
  // PI exposes no native session-id env var → nativeIdFromEnv is omitted; identity
  // comes from stdin (the session-file UUID the extension emits).
  expect(piAdapter.nativeIdFromEnv).toBeUndefined();
  expect(piAdapter.nativeIdFromStdin!({ session_id: "abc" })).toBe("abc");
  expect(piAdapter.nativeIdFromStdin!({})).toBeNull();
});

test("piAdapter passes the framework conformance battery", () => {
  const cfg = tmpCfg();
  const state = tmpState();
  const passed = assertAdapterConformance(piAdapter, {
    makeContext: () => ({ agentKind: "pi", profile: null, profileEnv: { PI_CODING_AGENT_DIR: cfg }, agmuxEmitPath: "/abs/agmux emit", stateDir: state }),
    makeResumeContext: (nid) => ({ agentKind: "pi", profile: null, command: "pi", args: [], cwd: "/work", env: {}, nativeSessionId: nid }),
  });
  expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/pi/index.ts`.

- [ ] **Step 3: Implement `index.ts`**

Create `packages/adapters/src/adapters/pi/index.ts`:

```ts
import type { Adapter } from "../../core/types.ts";
import { PI_SOURCES, PI_CAPABILITIES } from "./caps.ts";
import { normalizePi } from "./normalize.ts";
import { piResumePlan } from "./resume.ts";
import { piInstall, piUninstall, piStatus, ADAPTER_VERSION } from "./install.ts";

// PI (pi.dev). Install is a pure filesystem drop of an embedded extension
// (extension-files.ts) into <configDir>/extensions/ — no marketplace, no `pi`
// binary. PI exposes no native session-id env var, so identity comes from hook
// STDIN (spec §5) via nativeIdFromStdin — the session-file UUID the extension
// emits. This lets a bare `pi` launch self-register without the wrapper's claim.
export const piAdapter: Adapter = {
  agentKind: "pi",
  adapterVersion: ADAPTER_VERSION,
  sources: () => PI_SOURCES,
  capabilities: () => PI_CAPABILITIES,
  install: piInstall,
  uninstall: piUninstall,
  status: piStatus,
  normalize: normalizePi,
  resumePlan: piResumePlan,
  nativeIdFromStdin: (raw) => {
    const id = (raw as { session_id?: unknown } | null)?.session_id;
    return typeof id === "string" && id !== "" ? id : null;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/adapters/pi.test.ts`
Expected: PASS (full file).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/pi/index.ts packages/adapters/tests/adapters/pi.test.ts
git commit -m "adapters: assemble piAdapter + conformance"
```

---

### Task 9: Register `piAdapter` in the default registry

**Files:**
- Modify: `packages/adapters/src/adapters/index.ts`
- Test: `packages/adapters/tests/registry-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/tests/registry-wiring.test.ts`:

```ts
test("the default registry has the pi adapter wired in", () => {
  const r = createDefaultRegistry();
  expect(r.kinds()).toContain("pi");
  expect(r.lookup("pi")!.agentKind).toBe("pi");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/registry-wiring.test.ts`
Expected: FAIL — `r.lookup("pi")` is undefined.

- [ ] **Step 3: Implement the wiring**

Replace `packages/adapters/src/adapters/index.ts` with:

```ts
import type { Registry } from "../core/registry.ts";
import { claudeAdapter } from "./claude/index.ts";
import { codexAdapter } from "./codex/index.ts";
import { piAdapter } from "./pi/index.ts";

// THE per-provider wiring seam. Each provider adds one import + one register()
// call here, and nothing else in core changes.
export function registerAll(registry: Registry): void {
  registry.register(claudeAdapter);
  registry.register(codexAdapter);
  registry.register(piAdapter);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/registry-wiring.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/index.ts packages/adapters/tests/registry-wiring.test.ts
git commit -m "adapters: register pi in the default registry"
```

---

### Task 10: Whole-suite verification + README

**Files:**
- Modify: `README.md` (profile example + capability note)

- [ ] **Step 1: Typecheck the whole workspace**

Run: `bun run typecheck`
Expected: PASS (no errors). If `packages/cli` or `packages/wrapper` fails on an exhaustiveness/union error, it means a `"pi"` case is missing in a `switch` or literal — fix the reported file and re-run.

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: PASS (all packages). Confirms the new `pi` cases and that no existing claude/codex tests regressed.

- [ ] **Step 3: Update the README**

In `README.md`, add a `pi` profile after the `[profiles.codex-default]` block in the config example (around line 56-60):

```toml
[profiles.pi-default]
agent_kind = "pi"
command = "pi"
args = []
```

And add a one-line note after the ad-hoc launch examples (around line 65):

```
agmux run -p pi-default                   # PI session (auto-discovered extension)
```

- [ ] **Step 4: Verify README renders the intended commands**

Run: `grep -n "pi-default\|agent_kind = \"pi\"" README.md`
Expected: both the profile block and the run example appear.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "adapters: document pi profile in README"
```

---

## Self-Review

**Spec coverage:**
- §2 filesystem-only install → Task 7. §2.1 embedded payload → Task 5. §2.2 version/drift → Task 7 (`readInstalledVersion`, drift test).
- §3 sources/caps (usage hook-command/live, input.required absent) → Task 3.
- §4 event→point mapping → Task 5 (extension handlers) + Task 6 (normalize). §4.1 defensive usage mapping → Task 6 (`num()` + camelCase test).
- §5 identity (`nativeIdFromStdin`, no env id) + resume (`pi --session`) → Task 8 (shape test) + Task 4.
- §6 package layout → Tasks 3-8. §6.1 framework wiring (AgentKind, registerAll, profile, parse-run) → Tasks 1, 2, 9.
- §7 tests (conformance, normalize+fixture, install round-trip, registry) → Tasks 8, 6, 7, 9.
- §8 pitfalls — runtimeGate retained (Task 7), defensive usage (Task 6), getSessionFile null ⇒ no native id (handled by extension `sessionId()` returning null + `agmux emit` drop). §9 out-of-scope items intentionally not implemented.

**Placeholder scan:** No TBD/TODO; every code/test step shows complete content.

**Type consistency:** `PLUGIN_VERSION`/`EXTENSION_FILENAME`/`VERSION_MARKER`/`EXTENSION_FILES` exported by Task 5 and consumed identically in Tasks 5 (test), 7 (install). `ADAPTER_VERSION`, `resolveConfigDir`, `extensionsDir`, `piInstall/Uninstall/Status` defined in Task 7 and consumed in Tasks 7 (test), 8 (index). `normalizePi`/`piResumePlan`/`piAdapter` names consistent across definition and tests. Stdin field names (`session_id`, `pid`, `reason`, `prompt`, `tool_name`, `is_error`, `model`, `message_id`, `usage`) match between the extension payload (Task 5), the fixture (Task 6), and `PiHookStdin` (Task 6). The `dedup_key` format `pi:hook-command:<id>:<msgId>` is identical in impl and test.
