# Adapter Framework — Phase 2 (agent-agnostic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent-agnostic adapter framework — the `@agmux/adapters` package (the unified `Adapter` interface + core), the `agmux emit` runtime callback, the `agmux adapter` install/status CLI with a per-target ledger, and the two small enabling touch-points in wrapper/attach — so that each real provider can later be added by **one isolated subagent** dropping a single self-contained module behind a conformance gate.

**Architecture:** A new `@agmux/adapters` package splits into an agent-agnostic `core/` (interface, manifest vocabulary, registry, event-stamping, install/ledger, capabilities, and a reusable **conformance harness**) and a `adapters/` directory where each provider gets one self-contained module (none in this phase — that is the per-provider follow-on). The hub never imports adapter code; it keeps ingesting already-canonical events (Phase 1). `agmux emit` runs an adapter's `normalize()` client-side, stamps identity + dedup, and posts/queues to the existing hub. Everything degrades to today's MVP behavior when no adapter is installed.

**Tech Stack:** TypeScript on Bun, Bun workspaces monorepo (`packages/*`), `bun:sqlite` (only via the existing store), `bun test`, `ulid`, `smol-toml`.

**Spec:** [`docs/superpowers/specs/2026-05-29-adapters-framework-design.md`](../specs/2026-05-29-adapters-framework-design.md) §2 (core/adapter boundary), §2.1 (`Adapter` interface), §4 (`agmux emit`), §6 (profile-aware install, capabilities, resume), §7 (CLI), §8 (touch-points), §9 (per-provider follow-on).

**Builds on:** Phase 1 (`docs/superpowers/plans/2026-05-29-adapter-events-phase1.md`, landed) — protocol already has the adapter event kinds, payloads, `dedup_key` envelope field, `UsageReport`/`CapabilityMap`/`CapabilityDescriptor` in `telemetry.ts`, and the store already projects status/usage/capabilities and dedups on `dedup_key`. This phase produces those events.

**Out of this phase (per spec §1.4, §9):**
- **Any concrete provider adapter** (claude/codex/gemini/opencode/pi). Each is its own follow-on done by **one isolated subagent** — see the **Per-Provider Work Packages** appendix. This phase only builds the framework + a fake adapter used solely in tests to prove it.
- MCP transport; continuous source modes (`exec-json-stream`, `transcript-tail`); background native-file reconciliation; cost/pricing tables; output/stream capture.

---

## Design decisions locked here (read before starting)

1. **Core stays provider-agnostic — even about config paths.** `InstallContext` carries only `{ agentKind, profile, profileEnv, agmuxEmitPath, stateDir }`. A provider's native config dir and its `isolationMode` (`config-dir` vs `env-gated`, spec §6.1) are **resolved inside the adapter** (from `profileEnv` + `agentKind`), not handed down by core. This is a faithful refinement of spec §2.1: it keeps *all* provider knowledge in the adapter module, which is exactly what the per-provider isolation goal needs.
2. **`install`/`uninstall`/`status`/`normalize`/`resumePlan` are synchronous.** Adapters do local fs work; YAGNI on async (spec allowed `Promise`, we don't need it in v1).
3. **`session.adapter_attached` is emitted by `agmux emit --attach`, not by the wrapper.** The install wires a provider "session start" surface to call `agmux emit --attach`; emit loads the per-target ledger and emits that session's capabilities. This keeps the wrapper at exactly **two** touch-points (spec §8): inject `AGMUX_PROFILE`, and thread the resume plan.
4. **Resume is realized in `attach` (CLI), not inside the wrapper.** `attach` asks the adapter for a `resumePlan` and rewrites the inline-profile it already builds; the wrapper runs whatever inline profile it is given, unchanged. (Spec §6.4 calls this "the one wrapper touch-point"; in our code the relaunch path lives in `cli/src/attach.ts`.)
5. **The registry is the single provider wiring seam.** `packages/adapters/src/adapters/index.ts` exports `registerAll(registry)` — empty in v1. Each per-provider subagent adds exactly one `register(...)` line there. Nothing else in core changes per provider.

---

## File Structure

**`@agmux/adapters` (new package, `packages/adapters/`)**
- `package.json`, `tsconfig.json` *(create)* — workspace package, deps `@agmux/protocol` + `ulid`.
- `src/core/types.ts` *(create)* — the `Adapter` interface + every supporting type (the unified contract).
- `src/core/manifest.ts` *(create)* — `MANIFEST_POINTS` vocabulary + `isManifestPoint`.
- `src/core/registry.ts` *(create)* — `Registry` (`register`/`lookup`/`kinds`) + `createRegistry`.
- `src/core/normalize.ts` *(create)* — `stampEvents`: wrap an adapter's `CanonicalEvent[]` into canonical `EventEnvelope[]`.
- `src/core/capabilities.ts` *(create)* — `buildAttachedEvent` (the `session.adapter_attached` payload builder).
- `src/core/install.ts` *(create)* — `installAdapter`/`uninstallAdapter`/`loadRecord`/`ledgerPath` (per-target JSON ledger).
- `src/core/conformance.ts` *(create)* — `assertAdapterConformance`: the reusable structural battery every provider module must pass.
- `src/core/index.ts` *(create)* — barrel for `core/*`.
- `src/adapters/index.ts` *(create)* — `registerAll(registry)`, the per-provider wiring seam (empty in v1).
- `src/index.ts` *(create)* — package barrel; `createDefaultRegistry()`.
- `tests/fixtures/fake-adapter.ts` *(create)* — a fake `Adapter` used only by tests to exercise the framework end-to-end.
- `tests/*.test.ts` *(create)* — manifest, registry, normalize, capabilities, install, conformance.

**`@agmux/cli`**
- `src/emit.ts` *(create)* — `parseEmitArgs` + `runEmit` (the `agmux emit` runtime surface).
- `src/adapter-cmd.ts` *(create)* — `runAdapterCmd` (`agmux adapter list|install|status|uninstall`).
- `src/relaunch.ts` *(create)* — `buildRelaunchSpec` (resume-plan-aware relaunch spec).
- `src/attach.ts` *(modify)* — call `buildRelaunchSpec` instead of building the spec inline.
- `bin/agmux.ts` *(modify)* — dispatch `emit` + `adapter`; skip hub-ensure for them; usage text.
- `package.json` *(modify)* — add `@agmux/adapters` + `@agmux/wrapper` deps.

**`@agmux/wrapper`**
- `src/child-env.ts` *(create)* — `buildChildEnv` (injects `AGMUX_SESSION_ID`/`AGMUX_HUB_URL`/`AGMUX_PROFILE`).
- `src/index.ts` *(modify)* — use `buildChildEnv`; forward `AGMUX_PROFILE` through the tmux re-exec.

---

## Task 1: Scaffold the `@agmux/adapters` package

**Files:**
- Create: `packages/adapters/package.json`
- Create: `packages/adapters/tsconfig.json`
- Create: `packages/adapters/src/index.ts`

- [ ] **Step 1: Create the package manifest**

`packages/adapters/package.json`:

```json
{
  "name": "@agmux/adapters",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./tests/fixtures/fake-adapter.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@agmux/protocol": "workspace:*",
    "ulid": "^2.3.0"
  }
}
```

> The `./testing` subpath exposes the fake adapter (created in Task 7) to
> cross-package tests. The package's `exports` map blocks unlisted deep imports,
> so other packages import it as `@agmux/adapters/testing`, not by file path.

- [ ] **Step 2: Create the tsconfig (mirrors the other packages)**

`packages/adapters/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create a placeholder barrel**

`packages/adapters/src/index.ts`:

```typescript
// Package barrel. Re-exports land in Task 9 once core/ exists.
export {};
```

- [ ] **Step 4: Install the workspace so the new package resolves**

Run: `bun install`
Expected: completes; `@agmux/adapters` linked into the workspace.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @agmux/adapters typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/package.json packages/adapters/tsconfig.json packages/adapters/src/index.ts bun.lock package.json
git commit -m "adapters: scaffold @agmux/adapters package"
```

---

## Task 2: Core types — the `Adapter` interface + supporting types

**Files:**
- Create: `packages/adapters/src/core/types.ts`

- [ ] **Step 1: Write the types**

`packages/adapters/src/core/types.ts`:

```typescript
import type {
  AgentKind, AdapterEventKind, CapabilityMap, CapabilitySourceType,
} from "@agmux/protocol";

// The fixed, agent-agnostic hook-point vocabulary (spec §3.1). Finest grain so a
// provider can be honest about partial coverage. `session.adapter_attached` is
// NOT here — it is framework-emitted (Task 6), not a provider hook-point.
export const MANIFEST_POINTS = [
  "session.linked",
  "turn.started",
  "turn.ended",
  "input.required",
  "input.received",
  "usage.reported",
  "tool.used",
  "prompt.sent",
] as const;
export type ManifestPoint = (typeof MANIFEST_POINTS)[number];

// v1 ships event-triggered + on-demand only; continuous is reserved (spec §2.0).
export type ActivationMode = "event-triggered" | "continuous" | "on-demand";

// How a per-profile install is physically achieved on a given provider (spec §6.1).
export type IsolationMode = "config-dir" | "env-gated";

// A native surface the adapter wires up; each fulfils one or more manifest points.
export interface CapabilitySource {
  type: CapabilitySourceType;
  activation: ActivationMode;
  points: ManifestPoint[];
}

// The agent-agnostic install/runtime context. Provider-specific paths (config dir)
// and isolationMode are resolved INSIDE the adapter from these fields — core never
// learns provider layout (see "Design decisions locked here", #1).
export interface InstallContext {
  agentKind: AgentKind;
  profile: string | null;            // null = the bare `agent_kind` target
  profileEnv: Record<string, string>; // the env the target launches with (gating, $CODEX_HOME, etc.)
  agmuxEmitPath: string;             // absolute command to bake into hooks, e.g. "/usr/local/bin/agmux emit"
  stateDir: string;                  // ~/.agmux
}

// Everything an adapter needs to compute a native resume invocation (spec §6.4).
export interface ResumeContext {
  agentKind: AgentKind;
  profile: string | null;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  nativeSessionId: string | null;
}

// One reversible thing install() did. `config-key` carries the prior value in
// `restore` so uninstall can put it back; `file` artifacts are deleted.
export interface InstallArtifact {
  kind: "file" | "config-key";
  path: string;
  detail?: string;            // e.g. the config key name
  restore?: string | null;    // prior value for config-key (null = key was absent)
}

export interface InstallRecord {
  agentKind: AgentKind;
  profile: string | null;
  adapterVersion: string;
  isolationMode: IsolationMode;
  capabilities: CapabilityMap;
  artifacts: InstallArtifact[];
}

export interface InstallStatus {
  installed: boolean;
  version: string | null;
  drift: boolean;
  runtimeGate?: "hook-trust" | "none"; // provider trust/enable state (spec §6.2)
  detail?: string;
}

// Opaque resume plan (spec §6.4). resumable=false => caller relaunches fresh.
export interface ResumePlan {
  resumable: boolean;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  nativeSessionId?: string | null;
}

// A canonical event before identity/envelope stamping. emit stamps these (Task 5).
export interface CanonicalEvent {
  kind: AdapterEventKind;
  payload: unknown;
  dedup_key?: string | null;
}

// Runtime context handed to normalize() (spec §2.1 / §4.1).
export interface NormalizeInput {
  point: ManifestPoint;
  source: CapabilitySourceType;
  raw: unknown;                       // parsed provider payload (from stdin)
  cursor?: string | null;             // per-session source cursor (transcript offset, etc.)
  target: { agentKind: AgentKind; profile: string | null };
  agentVersion?: string | null;
}

export interface NormalizeOutput {
  events: CanonicalEvent[];
  cursor?: string | null;             // advanced cursor for cursor-bearing sources
}

// The unified contract every provider module implements (spec §2.1).
export interface Adapter {
  agentKind: AgentKind;
  adapterVersion: string;
  sources(ctx: InstallContext): CapabilitySource[];
  capabilities(ctx: InstallContext): CapabilityMap;
  install(ctx: InstallContext): InstallRecord;
  uninstall(ctx: InstallContext, record: InstallRecord): void;
  status(ctx: InstallContext): InstallStatus;
  normalize(input: NormalizeInput): NormalizeOutput;
  resumePlan(ctx: ResumeContext): ResumePlan;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter @agmux/adapters typecheck`
Expected: no errors (these are pure type declarations; they resolve against `@agmux/protocol`).

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/src/core/types.ts
git commit -m "adapters: core Adapter interface and supporting types"
```

---

## Task 3: Core — manifest vocabulary

**Files:**
- Create: `packages/adapters/src/core/manifest.ts`
- Test: `packages/adapters/tests/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapters/tests/manifest.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/manifest.test.ts`
Expected: FAIL — `manifest.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/adapters/src/core/manifest.ts`:

```typescript
import { MANIFEST_POINTS, type ManifestPoint } from "./types.ts";

export { MANIFEST_POINTS };
export type { ManifestPoint };

export function isManifestPoint(s: string): s is ManifestPoint {
  return (MANIFEST_POINTS as readonly string[]).includes(s);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/core/manifest.ts packages/adapters/tests/manifest.test.ts
git commit -m "adapters: manifest hook-point vocabulary"
```

---

## Task 4: Core — adapter registry

**Files:**
- Create: `packages/adapters/src/core/registry.ts`
- Test: `packages/adapters/tests/registry.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapters/tests/registry.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { createRegistry } from "../src/core/registry.ts";
import type { Adapter } from "../src/core/types.ts";

function stub(kind: "claude" | "codex"): Adapter {
  return {
    agentKind: kind, adapterVersion: "1",
    sources: () => [], capabilities: () => ({}),
    install: () => ({ agentKind: kind, profile: null, adapterVersion: "1", isolationMode: "config-dir", capabilities: {}, artifacts: [] }),
    uninstall: () => {}, status: () => ({ installed: false, version: null, drift: false }),
    normalize: () => ({ events: [] }),
    resumePlan: () => ({ resumable: false }),
  };
}

test("register then lookup returns the adapter", () => {
  const r = createRegistry();
  const a = stub("claude");
  r.register(a);
  expect(r.lookup("claude")).toBe(a);
  expect(r.lookup("codex")).toBeNull();
  expect(r.kinds()).toEqual(["claude"]);
});

test("double-registering the same kind throws", () => {
  const r = createRegistry();
  r.register(stub("claude"));
  expect(() => r.register(stub("claude"))).toThrow(/already registered/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/registry.test.ts`
Expected: FAIL — `registry.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/adapters/src/core/registry.ts`:

```typescript
import type { AgentKind } from "@agmux/protocol";
import type { Adapter } from "./types.ts";

export class Registry {
  private byKind = new Map<AgentKind, Adapter>();

  register(a: Adapter): void {
    if (this.byKind.has(a.agentKind)) {
      throw new Error(`adapter already registered for kind '${a.agentKind}'`);
    }
    this.byKind.set(a.agentKind, a);
  }

  lookup(kind: AgentKind): Adapter | null {
    return this.byKind.get(kind) ?? null;
  }

  kinds(): AgentKind[] {
    return [...this.byKind.keys()];
  }
}

export function createRegistry(): Registry {
  return new Registry();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/core/registry.ts packages/adapters/tests/registry.test.ts
git commit -m "adapters: provider registry"
```

---

## Task 5: Core — event stamping (`stampEvents`)

**Files:**
- Create: `packages/adapters/src/core/normalize.ts`
- Test: `packages/adapters/tests/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapters/tests/normalize.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { stampEvents } from "../src/core/normalize.ts";
import type { CanonicalEvent } from "../src/core/types.ts";

const events: CanonicalEvent[] = [
  { kind: "turn.started", payload: { turn_id: "t1" } },
  { kind: "usage.reported", payload: { cumulative: false, source: "transcript-delta", input_tokens: 5 }, dedup_key: "k:1" },
];

test("stampEvents fills the envelope, preserves kind/payload/dedup_key", () => {
  let i = 0;
  const out = stampEvents(events, {
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
    host: "h",
    now: () => "2026-05-29T10:00:00.000Z",
    newId: () => `id-${i++}`,
  });
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({
    event_id: "id-0", ts: "2026-05-29T10:00:00.000Z",
    session_id: "0190a3e0-0000-7000-8000-000000000000",
    kind: "turn.started", version: 1, host: "h",
    payload: { turn_id: "t1" }, dedup_key: null,
  });
  expect(out[1].dedup_key).toBe("k:1");
});

test("stampEvents defaults to real ulid + iso timestamp without injection", () => {
  const out = stampEvents([{ kind: "tool.used", payload: { tool: "bash" } }], { sessionId: "s", host: "h" });
  expect(out[0].event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID (Crockford base32)
  expect(out[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/normalize.test.ts`
Expected: FAIL — `normalize.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/adapters/src/core/normalize.ts`:

```typescript
import { ulid } from "ulid";
import type { EventEnvelope } from "@agmux/protocol";
import type { CanonicalEvent } from "./types.ts";

export interface StampOpts {
  sessionId: string;
  host: string;
  now?: () => string;     // injectable for deterministic tests
  newId?: () => string;   // injectable for deterministic tests
}

// Wrap an adapter's canonical events into fully-formed envelopes. version is
// always 1 (spec §3.3); dedup_key carries source-idempotency (spec §4.4) or null.
export function stampEvents(events: CanonicalEvent[], opts: StampOpts): EventEnvelope[] {
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? (() => ulid());
  return events.map((e) => ({
    event_id: newId(),
    ts: now(),
    session_id: opts.sessionId,
    kind: e.kind,
    version: 1,
    host: opts.host,
    payload: e.payload,
    dedup_key: e.dedup_key ?? null,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/core/normalize.ts packages/adapters/tests/normalize.test.ts
git commit -m "adapters: stampEvents envelope builder"
```

---

## Task 6: Core — `session.adapter_attached` builder

**Files:**
- Create: `packages/adapters/src/core/capabilities.ts`
- Test: `packages/adapters/tests/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapters/tests/capabilities.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { buildAttachedEvent } from "../src/core/capabilities.ts";

test("buildAttachedEvent emits a session.adapter_attached canonical event", () => {
  const caps = { "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" } } as const;
  const ev = buildAttachedEvent({
    agentKind: "codex", profile: "work", adapterVersion: "3", capabilities: caps,
  });
  expect(ev.kind).toBe("session.adapter_attached");
  expect(ev.dedup_key).toBeNull();
  expect(ev.payload).toEqual({
    agent_kind: "codex", profile: "work", adapter_version: "3", capabilities: caps,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/capabilities.test.ts`
Expected: FAIL — `capabilities.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/adapters/src/core/capabilities.ts`:

```typescript
import type { AgentKind, CapabilityMap, AdapterAttachedPayload } from "@agmux/protocol";
import type { CanonicalEvent } from "./types.ts";

// Build the per-session capabilities announcement (spec §6.2). Normally fed from
// the install ledger at session start by `agmux emit --attach` (Task 10).
export function buildAttachedEvent(args: {
  agentKind: AgentKind;
  profile: string | null;
  adapterVersion: string;
  capabilities: CapabilityMap;
}): CanonicalEvent {
  const payload: AdapterAttachedPayload = {
    agent_kind: args.agentKind,
    profile: args.profile,
    adapter_version: args.adapterVersion,
    capabilities: args.capabilities,
  };
  return { kind: "session.adapter_attached", payload, dedup_key: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/core/capabilities.ts packages/adapters/tests/capabilities.test.ts
git commit -m "adapters: session.adapter_attached event builder"
```

---

## Task 7: Core — install orchestration + per-target ledger

**Files:**
- Create: `packages/adapters/src/core/install.ts`
- Create: `packages/adapters/tests/fixtures/fake-adapter.ts`
- Test: `packages/adapters/tests/install.test.ts`

- [ ] **Step 1: Create the fake adapter fixture (used by Tasks 7 and 8)**

This fake `Adapter` is a test double — it stands in for a real provider so the
framework can be exercised without committing to any provider's specifics. It
resolves its "config dir" from `profileEnv.FAKE_CONFIG_DIR` (falling back under
`stateDir`), writes one marker file on install, and offers a native resume.

`packages/adapters/tests/fixtures/fake-adapter.ts`:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Adapter, InstallContext, InstallRecord, InstallStatus,
  NormalizeInput, NormalizeOutput, ResumeContext, ResumePlan, CapabilitySource,
} from "../../src/core/types.ts";
import type { CapabilityMap } from "@agmux/protocol";

function configDir(ctx: InstallContext): string {
  return ctx.profileEnv.FAKE_CONFIG_DIR ?? path.join(ctx.stateDir, "fake", ctx.profile ?? "_bare");
}
function markerFile(ctx: InstallContext): string {
  return path.join(configDir(ctx), "agmux-fake.json");
}

const CAPS: CapabilityMap = {
  "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.ended": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "input.required": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "input.received": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "session.linked": { fulfil: "yes", source: "transcript-delta", liveness: "backfilled" },
  "usage.reported": { fulfil: "partial", source: "transcript-delta", liveness: "backfilled" },
};

export const fakeAdapter: Adapter = {
  agentKind: "claude",
  adapterVersion: "1",

  sources(_ctx): CapabilitySource[] {
    return [
      { type: "hook-command", activation: "event-triggered", points: ["turn.started", "turn.ended", "input.required", "input.received"] },
      { type: "transcript-delta", activation: "event-triggered", points: ["session.linked", "usage.reported"] },
    ];
  },

  capabilities(_ctx): CapabilityMap {
    return CAPS;
  },

  install(ctx): InstallRecord {
    const file = markerFile(ctx);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ emit: ctx.agmuxEmitPath }));
    return {
      agentKind: "claude", profile: ctx.profile, adapterVersion: "1",
      isolationMode: "config-dir", capabilities: CAPS,
      artifacts: [{ kind: "file", path: file }],
    };
  },

  uninstall(_ctx, record): void {
    for (const a of record.artifacts) if (a.kind === "file") fs.rmSync(a.path, { force: true });
  },

  status(ctx): InstallStatus {
    const installed = fs.existsSync(markerFile(ctx));
    return { installed, version: installed ? "1" : null, drift: false, runtimeGate: "none" };
  },

  normalize(input: NormalizeInput): NormalizeOutput {
    if (input.point === "turn.started") {
      return { events: [{ kind: "turn.started", payload: { turn_id: (input.raw as any)?.turn_id ?? null } }] };
    }
    if (input.point === "usage.reported") {
      const offset = (input.raw as any)?.offset ?? 0;
      return {
        events: [{
          kind: "usage.reported",
          payload: { cumulative: false, source: "transcript-delta", input_tokens: (input.raw as any)?.input_tokens ?? 0 },
          dedup_key: `transcript-delta:${input.target.agentKind}:${offset}`,
        }],
        cursor: String(offset + 1),
      };
    }
    return { events: [] };
  },

  resumePlan(ctx: ResumeContext): ResumePlan {
    if (!ctx.nativeSessionId) return { resumable: false };
    return {
      resumable: true,
      argv: ["fake-cli", "resume", ctx.nativeSessionId],
      cwd: ctx.cwd,
      env: ctx.env,
      nativeSessionId: ctx.nativeSessionId,
    };
  },
};
```

- [ ] **Step 2: Write the failing test**

`packages/adapters/tests/install.test.ts`:

```typescript
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installAdapter, uninstallAdapter, loadRecord, ledgerPath } from "../src/core/install.ts";
import { fakeAdapter } from "./fixtures/fake-adapter.ts";
import type { InstallContext } from "../src/core/types.ts";

function tmpState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-adapters-"));
}
function ctxFor(stateDir: string, profile: string | null): InstallContext {
  return {
    agentKind: "claude", profile, profileEnv: { FAKE_CONFIG_DIR: path.join(stateDir, "cfg") },
    agmuxEmitPath: "/abs/agmux emit", stateDir,
  };
}

test("ledgerPath encodes profile vs bare target", () => {
  expect(ledgerPath("/s", "claude", null)).toBe("/s/adapters/claude.json");
  expect(ledgerPath("/s", "claude", "work")).toBe("/s/adapters/claude@work.json");
});

test("installAdapter writes the ledger and adapter marker; uninstall reverses both", () => {
  const stateDir = tmpState();
  const ctx = ctxFor(stateDir, "work");

  const rec = installAdapter(fakeAdapter, ctx);
  expect(rec.agentKind).toBe("claude");
  expect(fs.existsSync(ledgerPath(stateDir, "claude", "work"))).toBe(true);
  expect(fakeAdapter.status(ctx).installed).toBe(true);

  const loaded = loadRecord(stateDir, "claude", "work");
  expect(loaded!.adapterVersion).toBe("1");
  expect(loaded!.capabilities["turn.started"].fulfil).toBe("yes");

  expect(uninstallAdapter(fakeAdapter, ctx)).toBe(true);
  expect(fs.existsSync(ledgerPath(stateDir, "claude", "work"))).toBe(false);
  expect(fakeAdapter.status(ctx).installed).toBe(false);
});

test("uninstallAdapter on a never-installed target returns false", () => {
  const stateDir = tmpState();
  expect(uninstallAdapter(fakeAdapter, ctxFor(stateDir, null))).toBe(false);
});

test("installAdapter is idempotent (re-install overwrites, single ledger file)", () => {
  const stateDir = tmpState();
  const ctx = ctxFor(stateDir, null);
  installAdapter(fakeAdapter, ctx);
  installAdapter(fakeAdapter, ctx);
  expect(fs.existsSync(ledgerPath(stateDir, "claude", null))).toBe(true);
  expect(loadRecord(stateDir, "claude", null)!.adapterVersion).toBe("1");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/adapters/tests/install.test.ts`
Expected: FAIL — `install.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/adapters/src/core/install.ts`:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentKind } from "@agmux/protocol";
import type { Adapter, InstallContext, InstallRecord } from "./types.ts";

// Per-target ledger path (spec §6.3): bare kind => "<kind>.json", profile target
// => "<kind>@<profile>.json", under <stateDir>/adapters/.
export function ledgerPath(stateDir: string, agentKind: AgentKind | string, profile: string | null): string {
  const name = profile ? `${agentKind}@${profile}` : `${agentKind}`;
  return path.join(stateDir, "adapters", `${name}.json`);
}

export function installAdapter(adapter: Adapter, ctx: InstallContext): InstallRecord {
  const record = adapter.install(ctx);
  const p = ledgerPath(ctx.stateDir, ctx.agentKind, ctx.profile);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2));
  return record;
}

export function loadRecord(stateDir: string, agentKind: AgentKind | string, profile: string | null): InstallRecord | null {
  const p = ledgerPath(stateDir, agentKind, profile);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as InstallRecord;
}

export function uninstallAdapter(adapter: Adapter, ctx: InstallContext): boolean {
  const record = loadRecord(ctx.stateDir, ctx.agentKind, ctx.profile);
  if (!record) return false;
  adapter.uninstall(ctx, record);
  fs.rmSync(ledgerPath(ctx.stateDir, ctx.agentKind, ctx.profile), { force: true });
  return true;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/adapters/tests/install.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/core/install.ts packages/adapters/tests/fixtures/fake-adapter.ts packages/adapters/tests/install.test.ts
git commit -m "adapters: install orchestration, per-target ledger, fake adapter fixture"
```

---

## Task 8: Core — the conformance harness

This is the **isolation enabler**: a reusable structural battery any provider
module must pass. A per-provider subagent's acceptance gate is "make
`assertAdapterConformance(myAdapter, ...)` pass" — without ever seeing other
providers' code.

**Files:**
- Create: `packages/adapters/src/core/conformance.ts`
- Test: `packages/adapters/tests/conformance.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/adapters/tests/conformance.test.ts`:

```typescript
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertAdapterConformance } from "../src/core/conformance.ts";
import { fakeAdapter } from "./fixtures/fake-adapter.ts";
import type { Adapter, InstallContext, ResumeContext } from "../src/core/types.ts";

function harness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-conf-"));
  const makeContext = (): InstallContext => ({
    agentKind: "claude", profile: null, profileEnv: { FAKE_CONFIG_DIR: path.join(stateDir, "cfg") },
    agmuxEmitPath: "/abs/agmux emit", stateDir,
  });
  const makeResumeContext = (nid: string | null): ResumeContext => ({
    agentKind: "claude", profile: null, command: "claude", args: [], cwd: "/tmp", env: {}, nativeSessionId: nid,
  });
  return { makeContext, makeResumeContext };
}

test("the fake adapter passes the full conformance battery", () => {
  const passed = assertAdapterConformance(fakeAdapter, harness());
  expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan"]);
});

test("conformance rejects a capability not covered by any source", () => {
  const broken: Adapter = {
    ...fakeAdapter,
    sources: () => [],                            // declares NO sources...
    capabilities: () => ({ "turn.started": { fulfil: "yes" } }), // ...but claims a capability
  };
  expect(() => assertAdapterConformance(broken, harness())).toThrow(/no source covers it/);
});

test("conformance rejects a source pointing at a non-manifest point", () => {
  const broken: Adapter = {
    ...fakeAdapter,
    sources: () => [{ type: "hook-command", activation: "event-triggered", points: ["bogus.point" as any] }],
  };
  expect(() => assertAdapterConformance(broken, harness())).toThrow(/not a manifest point/);
});

test("conformance rejects a resumable plan with no argv", () => {
  const broken: Adapter = {
    ...fakeAdapter,
    resumePlan: () => ({ resumable: true }), // resumable but no argv
  };
  expect(() => assertAdapterConformance(broken, harness())).toThrow(/non-empty argv/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/tests/conformance.test.ts`
Expected: FAIL — `conformance.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/adapters/src/core/conformance.ts`:

```typescript
import { isManifestPoint } from "./manifest.ts";
import type { Adapter, InstallContext, ResumeContext } from "./types.ts";

export interface ConformanceHarness {
  makeContext: () => InstallContext;
  makeResumeContext: (nativeSessionId: string | null) => ResumeContext;
}

// Provider-agnostic STRUCTURAL conformance. Verifies an adapter honors the
// framework contract. It does NOT check normalize() correctness — that needs
// real provider fixtures and is owned by the per-provider test (see the plan's
// Per-Provider Work Packages appendix). Throws on the first violation; returns
// the names of the checks that passed.
export function assertAdapterConformance(adapter: Adapter, h: ConformanceHarness): string[] {
  const passed: string[] = [];
  const ctx = h.makeContext();

  if (!adapter.agentKind) throw new Error("conformance: agentKind missing");
  if (!adapter.adapterVersion) throw new Error("conformance: adapterVersion missing");
  passed.push("identity");

  const sources = adapter.sources(ctx);
  if (!Array.isArray(sources)) throw new Error("conformance: sources() must return an array");
  for (const s of sources) {
    for (const pt of s.points) {
      if (!isManifestPoint(pt)) throw new Error(`conformance: source point '${pt}' is not a manifest point`);
    }
  }
  passed.push("sources");

  const caps = adapter.capabilities(ctx);
  const covered = new Set<string>(sources.flatMap((s) => s.points as string[]));
  for (const [pt, d] of Object.entries(caps)) {
    if (!isManifestPoint(pt)) throw new Error(`conformance: capability key '${pt}' is not a manifest point`);
    if (d.fulfil !== "no" && !covered.has(pt)) {
      throw new Error(`conformance: capability '${pt}' is '${d.fulfil}' but no source covers it`);
    }
  }
  passed.push("capabilities");

  const record = adapter.install(ctx);
  if (record.agentKind !== adapter.agentKind) throw new Error("conformance: record.agentKind mismatch");
  if (adapter.status(ctx).installed !== true) throw new Error("conformance: status not installed after install()");
  adapter.uninstall(ctx, record);
  if (adapter.status(ctx).installed !== false) throw new Error("conformance: status still installed after uninstall()");
  passed.push("install-roundtrip");

  const planNo = adapter.resumePlan(h.makeResumeContext(null));
  if (typeof planNo.resumable !== "boolean") throw new Error("conformance: resumePlan.resumable not boolean");
  const planYes = adapter.resumePlan(h.makeResumeContext("native-123"));
  if (planYes.resumable && (!Array.isArray(planYes.argv) || planYes.argv.length === 0)) {
    throw new Error("conformance: a resumable plan must carry a non-empty argv");
  }
  passed.push("resumePlan");

  return passed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/tests/conformance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/core/conformance.ts packages/adapters/tests/conformance.test.ts
git commit -m "adapters: reusable structural conformance harness"
```

---

## Task 9: Barrels + the per-provider wiring seam

**Files:**
- Create: `packages/adapters/src/core/index.ts`
- Create: `packages/adapters/src/adapters/index.ts`
- Modify: `packages/adapters/src/index.ts`

- [ ] **Step 1: Create the core barrel**

`packages/adapters/src/core/index.ts`:

```typescript
export * from "./types.ts";
export * from "./manifest.ts";
export * from "./registry.ts";
export * from "./normalize.ts";
export * from "./capabilities.ts";
export * from "./install.ts";
export * from "./conformance.ts";
```

- [ ] **Step 2: Create the per-provider wiring seam (empty in v1)**

`packages/adapters/src/adapters/index.ts`:

```typescript
import type { Registry } from "../core/registry.ts";

// THE per-provider wiring seam. Each per-provider subagent (see the Phase-2 plan's
// "Per-Provider Work Packages" appendix) adds exactly one import + one register()
// call here, and nothing else in core changes. Empty in v1 by design — the
// framework ships with zero concrete providers.
export function registerAll(_registry: Registry): void {
  // e.g. _registry.register(claudeAdapter);
}
```

- [ ] **Step 3: Wire the package barrel + default registry**

`packages/adapters/src/index.ts` (replace the placeholder):

```typescript
export * from "./core/index.ts";
import { createRegistry, type Registry } from "./core/registry.ts";
import { registerAll } from "./adapters/index.ts";

// The registry the CLI uses by default. v1: contains no providers (registerAll is
// empty), so `agmux emit`/`agmux adapter` degrade gracefully until a provider lands.
export function createDefaultRegistry(): Registry {
  const r = createRegistry();
  registerAll(r);
  return r;
}
```

- [ ] **Step 4: Typecheck + run the whole package's tests**

Run: `bun run --filter @agmux/adapters typecheck && bun test packages/adapters`
Expected: typecheck clean; all adapter tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/core/index.ts packages/adapters/src/adapters/index.ts packages/adapters/src/index.ts
git commit -m "adapters: barrels and default registry seam"
```

---

## Task 10: CLI — the `agmux emit` runtime callback

**Files:**
- Create: `packages/cli/src/emit.ts`
- Modify: `packages/cli/package.json` (add `@agmux/adapters` dep)
- Modify: `packages/cli/bin/agmux.ts` (dispatch `emit`, skip hub-ensure)
- Test: `packages/cli/tests/emit.test.ts`

- [ ] **Step 1: Add the adapters dependency to the CLI**

In `packages/cli/package.json`, add `@agmux/adapters` to `dependencies`:

```json
  "dependencies": {
    "@agmux/protocol": "workspace:*",
    "@agmux/hub": "workspace:*",
    "@agmux/adapters": "workspace:*"
  },
```

Then run: `bun install`
Expected: completes, `@agmux/adapters` linked into the CLI.

- [ ] **Step 2: Write the failing test**

`packages/cli/tests/emit.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { parseEmitArgs, runEmit } from "../src/emit.ts";
import { createRegistry } from "@agmux/adapters";
import { fakeAdapter } from "@agmux/adapters/testing";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function reg() { const r = createRegistry(); r.register(fakeAdapter); return r; }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-emit-")); }

test("parseEmitArgs reads flags", () => {
  const a = parseEmitArgs(["--from=claude", "--source=hook-command", "--point=turn.started"]);
  expect(a).toEqual({ from: "claude", source: "hook-command", point: "turn.started", attach: false, profile: null, cursorFile: null });
});

test("runEmit posts a normalized event to the hub", async () => {
  const stateDir = tmp();
  const posted: any[] = [];
  const fakeFetch = (async (_url: string, init: any) => {
    posted.push(...JSON.parse(init.body));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;

  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { AGMUX_SESSION_ID: "sid-1", AGMUX_HUB_URL: "http://hub" },
    stdin: JSON.stringify({ turn_id: "t9" }),
    host: "h", stateDir, fetchImpl: fakeFetch,
  });

  expect(posted).toHaveLength(1);
  expect(posted[0].kind).toBe("turn.started");
  expect(posted[0].session_id).toBe("sid-1");
  expect(posted[0].payload.turn_id).toBe("t9");
});

test("runEmit drops the event (no throw, nothing posted) when AGMUX_SESSION_ID is absent", async () => {
  const stateDir = tmp();
  let called = false;
  const fakeFetch = (async () => { called = true; return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(), env: {}, stdin: "{}", host: "h", stateDir, fetchImpl: fakeFetch,
  });
  expect(called).toBe(false);
});

test("runEmit queues to disk when the hub POST fails", async () => {
  const stateDir = tmp();
  const failing = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { AGMUX_SESSION_ID: "sid-q", AGMUX_HUB_URL: "http://hub" },
    stdin: "{}", host: "h", stateDir, fetchImpl: failing,
  });
  const qf = path.join(stateDir, "queue", "sid-q.jsonl");
  expect(fs.existsSync(qf)).toBe(true);
  expect(fs.readFileSync(qf, "utf8").trim().length).toBeGreaterThan(0);
});

test("runEmit --attach emits capabilities from the ledger", async () => {
  const stateDir = tmp();
  // Seed a ledger record by installing the fake adapter for the bare claude target.
  const { installAdapter } = await import("@agmux/adapters");
  installAdapter(fakeAdapter, { agentKind: "claude", profile: null, profileEnv: { FAKE_CONFIG_DIR: path.join(stateDir, "cfg") }, agmuxEmitPath: "x", stateDir });

  const posted: any[] = [];
  const fakeFetch = (async (_u: string, init: any) => { posted.push(...JSON.parse(init.body)); return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--attach"], {
    registry: reg(), env: { AGMUX_SESSION_ID: "sid-a", AGMUX_HUB_URL: "http://hub" },
    stdin: "", host: "h", stateDir, fetchImpl: fakeFetch,
  });
  expect(posted).toHaveLength(1);
  expect(posted[0].kind).toBe("session.adapter_attached");
  expect(posted[0].payload.capabilities["turn.started"].fulfil).toBe("yes");
});

test("runEmit never throws on an unknown agent_kind", async () => {
  const stateDir = tmp();
  await runEmit(["--from=codex", "--source=hook-command", "--point=turn.started"], {
    registry: reg(), env: { AGMUX_SESSION_ID: "s", AGMUX_HUB_URL: "http://hub" }, stdin: "{}", host: "h", stateDir,
  });
  // No adapter for codex in this registry → returns quietly. (No assertion needed; absence of throw is the test.)
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/cli/tests/emit.test.ts`
Expected: FAIL — `emit.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/cli/src/emit.ts`:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV,
} from "@agmux/protocol";
import type { AgentKind, CapabilitySourceType, EventEnvelope } from "@agmux/protocol";
import {
  stampEvents, buildAttachedEvent, loadRecord,
  type Registry, type CanonicalEvent, type ManifestPoint,
} from "@agmux/adapters";

export interface ParsedEmit {
  from: string;
  source: CapabilitySourceType | null;
  point: ManifestPoint | null;
  attach: boolean;
  profile: string | null;
  cursorFile: string | null;
}

export function parseEmitArgs(argv: string[]): ParsedEmit {
  const get = (k: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`${k}=`));
    return hit ? hit.slice(k.length + 1) : null;
  };
  return {
    from: get("--from") ?? "",
    source: (get("--source") as CapabilitySourceType | null) ?? null,
    point: (get("--point") as ManifestPoint | null) ?? null,
    attach: argv.includes("--attach"),
    profile: get("--profile"),
    cursorFile: get("--cursor-file"),
  };
}

export interface EmitDeps {
  registry: Registry;
  env: Record<string, string | undefined>;
  stdin: string;
  host: string;
  stateDir: string;
  now?: () => string;
  newId?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function parseRaw(stdin: string): unknown {
  const s = stdin.trim();
  if (s === "") return {};
  try { return JSON.parse(s); } catch { return { raw: stdin }; }
}

// Hot-path contract (spec §4.2): NEVER throws, NEVER writes stdout, drops on
// missing identity, falls back to the per-session queue on any post failure.
export async function runEmit(argv: string[], deps: EmitDeps): Promise<void> {
  try {
    const a = parseEmitArgs(argv);
    const sessionId = deps.env[AGMUX_SESSION_ID_ENV];
    if (!sessionId) return; // drop, don't guess (spec §3.3)
    if (!a.from) return;
    const adapter = deps.registry.lookup(a.from as AgentKind);
    if (!adapter) return;

    let events: CanonicalEvent[];
    if (a.attach) {
      const rec = loadRecord(deps.stateDir, a.from, a.profile);
      if (!rec) return;
      events = [buildAttachedEvent({
        agentKind: a.from as AgentKind, profile: rec.profile,
        adapterVersion: rec.adapterVersion, capabilities: rec.capabilities,
      })];
    } else {
      if (!a.point || !a.source) return;
      const cursor = a.cursorFile && fs.existsSync(a.cursorFile) ? fs.readFileSync(a.cursorFile, "utf8") : null;
      const out = adapter.normalize({
        point: a.point, source: a.source, raw: parseRaw(deps.stdin), cursor,
        target: { agentKind: a.from as AgentKind, profile: a.profile },
      });
      events = out.events;
      if (a.cursorFile && out.cursor != null) {
        try { fs.writeFileSync(a.cursorFile, out.cursor); } catch { /* best-effort */ }
      }
    }
    if (events.length === 0) return;

    const stamped = stampEvents(events, { sessionId, host: deps.host, now: deps.now, newId: deps.newId });
    await postOrQueue(stamped, {
      hubUrl: deps.env[AGMUX_HUB_URL_ENV], stateDir: deps.stateDir, sessionId,
      fetchImpl: deps.fetchImpl ?? fetch, timeoutMs: deps.timeoutMs ?? 1500,
    });
  } catch {
    // Swallow everything: a telemetry failure must never break the agent.
  }
}

async function postOrQueue(events: EventEnvelope[], o: {
  hubUrl: string | undefined; stateDir: string; sessionId: string;
  fetchImpl: typeof fetch; timeoutMs: number;
}): Promise<void> {
  if (o.hubUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), o.timeoutMs);
      const res = await o.fetchImpl(`${o.hubUrl}/ingest`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events), signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status < 500 && res.status !== 0) return; // 2xx/4xx = delivered or unrecoverable
    } catch { /* fall through to queue */ }
  }
  const queueDir = path.join(o.stateDir, "queue");
  fs.mkdirSync(queueDir, { recursive: true });
  const qf = path.join(queueDir, `${o.sessionId}.jsonl`);
  fs.appendFileSync(qf, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/cli/tests/emit.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire `emit` into the dispatcher (before hub-ensure)**

In `packages/cli/bin/agmux.ts`, add an import near the others:

```typescript
import { runEmit } from "../src/emit.ts";
import { createDefaultRegistry } from "@agmux/adapters";
```

Then, in `main()`, **before** the `const hubUrl = await ensureHubRunning(...)` line, add the emit short-circuit (emit must not spawn the hub — it posts-or-queues):

```typescript
  if (verb === "emit") {
    const chunks: Buffer[] = [];
    for await (const c of Bun.stdin.stream()) chunks.push(Buffer.from(c));
    const stdin = Buffer.concat(chunks).toString("utf8");
    await runEmit(argv.slice(1), {
      registry: createDefaultRegistry(),
      env: process.env,
      stdin,
      host: os.hostname(),
      stateDir,
    });
    return 0; // always 0 — never break the agent's surface
  }
```

- [ ] **Step 7: Typecheck the CLI**

Run: `bun run --filter @agmux/cli typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/emit.ts packages/cli/bin/agmux.ts packages/cli/package.json bun.lock
git commit -m "cli: agmux emit runtime callback surface"
```

---

## Task 11: CLI — the `agmux adapter` verb group

**Files:**
- Create: `packages/cli/src/adapter-cmd.ts`
- Modify: `packages/wrapper/src/index.ts` (re-export `loadProfile`/`parseConfig`/`ProfileConfig`)
- Modify: `packages/cli/package.json` (add `@agmux/wrapper` dep)
- Modify: `packages/cli/bin/agmux.ts` (dispatch `adapter`, skip hub-ensure)
- Test: `packages/cli/tests/adapter-cmd.test.ts`

- [ ] **Step 1: Re-export the profile loader from the wrapper barrel**

The CLI needs to resolve a profile's `agent_kind` + `env` to build an
`InstallContext`. Reuse the wrapper's loader rather than duplicating TOML parsing.
In `packages/wrapper/src/index.ts`, add at the top of the file (after the existing imports):

```typescript
export { loadProfile, parseConfig, expandTilde, type ProfileConfig, type AgmuxConfig } from "./profile.ts";
```

- [ ] **Step 2: Add the wrapper dependency to the CLI**

In `packages/cli/package.json`, add `@agmux/wrapper` to `dependencies` (alongside the `@agmux/adapters` line added in Task 10):

```json
  "dependencies": {
    "@agmux/protocol": "workspace:*",
    "@agmux/hub": "workspace:*",
    "@agmux/adapters": "workspace:*",
    "@agmux/wrapper": "workspace:*"
  },
```

Then run: `bun install`
Expected: completes; `@agmux/wrapper` linked into the CLI.

- [ ] **Step 3: Write the failing test**

`packages/cli/tests/adapter-cmd.test.ts`:

```typescript
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAdapterCmd } from "../src/adapter-cmd.ts";
import { createRegistry, loadRecord } from "@agmux/adapters";
import { fakeAdapter } from "@agmux/adapters/testing";

function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-adpcmd-"));
  const configPath = path.join(stateDir, "config.toml");
  // A profile whose agent_kind is claude (the fake adapter's kind).
  fs.writeFileSync(configPath, [
    `[profiles.work]`,
    `agent_kind = "claude"`,
    `command = "claude"`,
    `env = { FAKE_CONFIG_DIR = "${path.join(stateDir, "work-cfg")}" }`,
  ].join("\n"));
  const out: string[] = [];
  const reg = createRegistry(); reg.register(fakeAdapter);
  return {
    stateDir, configPath, out,
    deps: { registry: reg, stateDir, configPath, agmuxEmitPath: "/abs/agmux emit", out: (s: string) => out.push(s) },
  };
}

test("adapter install <profile> writes a ledger and reports success", async () => {
  const s = setup();
  const rc = await runAdapterCmd(["install", "work"], s.deps);
  expect(rc).toBe(0);
  expect(loadRecord(s.stateDir, "claude", "work")).not.toBeNull();
  expect(s.out.join("\n")).toMatch(/installed claude@work/);
});

test("adapter status reflects install then uninstall", async () => {
  const s = setup();
  await runAdapterCmd(["install", "work"], s.deps);
  await runAdapterCmd(["status", "work"], s.deps);
  expect(s.out.join("\n")).toMatch(/installed/);

  const rc = await runAdapterCmd(["uninstall", "work"], s.deps);
  expect(rc).toBe(0);
  expect(loadRecord(s.stateDir, "claude", "work")).toBeNull();
});

test("adapter install --kind claude targets the bare kind", async () => {
  const s = setup();
  const rc = await runAdapterCmd(["install", "--kind", "claude"], s.deps);
  expect(rc).toBe(0);
  expect(loadRecord(s.stateDir, "claude", null)).not.toBeNull();
  expect(s.out.join("\n")).toMatch(/installed claude \(bare\)/);
});

test("adapter install for a kind with no registered adapter errors cleanly", async () => {
  const s = setup();
  const rc = await runAdapterCmd(["install", "--kind", "codex"], s.deps);
  expect(rc).toBe(1);
  expect(s.out.join("\n")).toMatch(/no adapter registered for kind 'codex'/);
});

test("adapter list shows registered kinds and install state", async () => {
  const s = setup();
  await runAdapterCmd(["install", "work"], s.deps);
  await runAdapterCmd(["list"], s.deps);
  const text = s.out.join("\n");
  expect(text).toMatch(/claude/);
  expect(text).toMatch(/work/);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test packages/cli/tests/adapter-cmd.test.ts`
Expected: FAIL — `adapter-cmd.ts` does not exist.

- [ ] **Step 5: Implement**

`packages/cli/src/adapter-cmd.ts`:

```typescript
import * as fs from "node:fs";
import type { AgentKind } from "@agmux/protocol";
import {
  installAdapter, uninstallAdapter, loadRecord,
  type Registry, type InstallContext,
} from "@agmux/adapters";
import { parseConfig, type AgmuxConfig } from "@agmux/wrapper";

export interface AdapterCmdDeps {
  registry: Registry;
  stateDir: string;
  configPath: string;
  agmuxEmitPath: string;
  out: (line: string) => void;
}

interface Target { agentKind: AgentKind; profile: string | null; profileEnv: Record<string, string>; }

function readConfig(configPath: string): AgmuxConfig {
  if (!fs.existsSync(configPath)) return { profiles: {} };
  return parseConfig(fs.readFileSync(configPath, "utf8"));
}

// Resolve a CLI target. `["work"]` => profile "work"; `["--kind","claude"]` => bare kind.
function resolveTarget(args: string[], cfg: AgmuxConfig): Target | { error: string } {
  const kindIdx = args.indexOf("--kind");
  if (kindIdx >= 0) {
    const k = args[kindIdx + 1];
    if (k !== "claude" && k !== "codex") return { error: `--kind must be 'claude' or 'codex'` };
    return { agentKind: k, profile: null, profileEnv: {} };
  }
  const profile = args.find((a) => !a.startsWith("-"));
  if (!profile) return { error: "expected a <profile> name or --kind <agent_kind>" };
  const p = cfg.profiles[profile];
  if (!p) return { error: `profile not found: ${profile}` };
  return { agentKind: p.agent_kind, profile, profileEnv: p.env };
}

function ctxFor(t: Target, deps: AdapterCmdDeps): InstallContext {
  return {
    agentKind: t.agentKind, profile: t.profile, profileEnv: t.profileEnv,
    agmuxEmitPath: deps.agmuxEmitPath, stateDir: deps.stateDir,
  };
}

function label(t: { agentKind: AgentKind; profile: string | null }): string {
  return t.profile ? `${t.agentKind}@${t.profile}` : `${t.agentKind} (bare)`;
}

export async function runAdapterCmd(args: string[], deps: AdapterCmdDeps): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const cfg = readConfig(deps.configPath);

  if (sub === "list") {
    const kinds = deps.registry.kinds();
    if (kinds.length === 0) {
      deps.out("no adapters registered (per-provider modules land in packages/adapters/src/adapters/index.ts)");
      return 0;
    }
    for (const kind of kinds) {
      const bare = loadRecord(deps.stateDir, kind, null);
      deps.out(`${kind} (bare): ${bare ? `installed (v${bare.adapterVersion})` : "not installed"}`);
      for (const [name, p] of Object.entries(cfg.profiles)) {
        if (p.agent_kind !== kind) continue;
        const rec = loadRecord(deps.stateDir, kind, name);
        deps.out(`${kind}@${name}: ${rec ? `installed (v${rec.adapterVersion})` : "not installed"}`);
      }
    }
    return 0;
  }

  if (sub === "install" || sub === "uninstall" || sub === "status") {
    const t = resolveTarget(rest, cfg);
    if ("error" in t) { deps.out(t.error); return 2; }
    const adapter = deps.registry.lookup(t.agentKind);
    if (!adapter) { deps.out(`no adapter registered for kind '${t.agentKind}'`); return 1; }
    const ctx = ctxFor(t, deps);

    if (sub === "install") {
      const rec = installAdapter(adapter, ctx);
      deps.out(`installed ${label(t)} (v${rec.adapterVersion})`);
      return 0;
    }
    if (sub === "uninstall") {
      const ok = uninstallAdapter(adapter, ctx);
      deps.out(ok ? `uninstalled ${label(t)}` : `${label(t)} was not installed`);
      return 0;
    }
    // status
    const st = adapter.status(ctx);
    deps.out(`${label(t)}: ${st.installed ? `installed (v${st.version})` : "not installed"}${st.drift ? " [drift]" : ""}`);
    return 0;
  }

  deps.out("usage: agmux adapter list|install|status|uninstall (<profile> | --kind <agent_kind>)");
  return 2;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/cli/tests/adapter-cmd.test.ts`
Expected: PASS.

- [ ] **Step 7: Wire `adapter` into the dispatcher**

In `packages/cli/bin/agmux.ts`, add the import:

```typescript
import { runAdapterCmd } from "../src/adapter-cmd.ts";
```

Add the `adapter` short-circuit **right after** the `emit` block from Task 10 (also before `ensureHubRunning` — adapter install needs no hub):

```typescript
  if (verb === "adapter") {
    const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
    return runAdapterCmd(argv.slice(1), {
      registry: createDefaultRegistry(),
      stateDir,
      configPath,
      agmuxEmitPath: `${process.env.AGMUX_BIN ?? "agmux"} emit`,
      out: (s) => console.log(s),
    });
  }
```

Add `AGMUX_CONFIG_SUBPATH` to the existing `@agmux/protocol` import at the top of the file:

```typescript
import { AGMUX_STATE_DIR_DEFAULT, AGMUX_CONFIG_SUBPATH } from "@agmux/protocol";
```

Add the two new verbs to the `usage()` text:

```typescript
  adapter list|install|status|uninstall (<profile> | --kind <agent_kind>)
  emit ...   (runtime callback; not user-facing)
```

- [ ] **Step 8: Typecheck the CLI + wrapper**

Run: `bun run --filter @agmux/cli typecheck && bun run --filter @agmux/wrapper typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/adapter-cmd.ts packages/cli/bin/agmux.ts packages/cli/package.json packages/wrapper/src/index.ts bun.lock
git commit -m "cli: agmux adapter install/status/uninstall/list verb group"
```

---

## Task 12: Wrapper — inject `AGMUX_PROFILE` into the agent's env

**Files:**
- Create: `packages/wrapper/src/child-env.ts`
- Modify: `packages/wrapper/src/index.ts`
- Test: `packages/wrapper/tests/child-env.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/wrapper/tests/child-env.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { buildChildEnv } from "../src/child-env.ts";

test("buildChildEnv injects session id, hub url, profile env, and AGMUX_PROFILE", () => {
  const env = buildChildEnv(
    { PATH: "/usr/bin", UNDEF: undefined },
    { sessionId: "sid", hubUrl: "http://hub", profileEnv: { FOO: "bar" }, profileName: "work" },
  );
  expect(env.PATH).toBe("/usr/bin");
  expect(env.FOO).toBe("bar");
  expect(env.AGMUX_SESSION_ID).toBe("sid");
  expect(env.AGMUX_HUB_URL).toBe("http://hub");
  expect(env.AGMUX_PROFILE).toBe("work");
  expect("UNDEF" in env).toBe(false);
});

test("buildChildEnv omits AGMUX_PROFILE for a bare (null-profile) run", () => {
  const env = buildChildEnv({}, { sessionId: "sid", hubUrl: "http://hub", profileEnv: {}, profileName: null });
  expect("AGMUX_PROFILE" in env).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/wrapper/tests/child-env.test.ts`
Expected: FAIL — `child-env.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/wrapper/src/child-env.ts`:

```typescript
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV, AGMUX_PROFILE_ENV } from "@agmux/protocol";

// Build the env the agent child runs with. AGMUX_PROFILE is set only for a named
// profile — it is the runtime gate `env-gated` adapter installs key off (spec §6.1).
export function buildChildEnv(
  base: Record<string, string | undefined>,
  a: { sessionId: string; hubUrl: string; profileEnv: Record<string, string>; profileName: string | null },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  Object.assign(env, a.profileEnv);
  env[AGMUX_SESSION_ID_ENV] = a.sessionId;
  env[AGMUX_HUB_URL_ENV] = a.hubUrl;
  if (a.profileName) env[AGMUX_PROFILE_ENV] = a.profileName;
  return env;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/wrapper/tests/child-env.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in the wrapper**

In `packages/wrapper/src/index.ts`:

Add the import (alongside the existing `@agmux/protocol` import — `AGMUX_PROFILE_ENV` is now used transitively via `buildChildEnv`, but we also need it in the tmux forward list below):

```typescript
import { buildChildEnv } from "./child-env.ts";
import { AGMUX_PROFILE_ENV } from "@agmux/protocol";
```

Replace the child-spawn `env` block (the `Bun.spawn([profile.command, ...profile.args], { ... env: { ...process.env, ...profile.env, [AGMUX_SESSION_ID_ENV]: sessionId, [AGMUX_HUB_URL_ENV]: opts.hubUrl } })`) with:

```typescript
  const child = Bun.spawn([profile.command, ...profile.args], {
    stdin: slave, stdout: slaveOut, stderr: slaveErr,
    cwd: profile.cwd ?? process.cwd(),
    env: buildChildEnv(process.env, {
      sessionId,
      hubUrl: opts.hubUrl,
      profileEnv: profile.env,
      profileName: opts.profileName,
    }),
  });
```

Add `AGMUX_PROFILE_ENV` to the tmux re-exec forward list (the `for (const k of [...] as const)` array that currently lists `"AGMUX_INLINE_PROFILE"`, `AGMUX_HUB_URL_ENV`, `AGMUX_SESSION_ID_ENV`, `AGMUX_TMUX_SESSION_ENV`):

```typescript
    for (const k of [
      "AGMUX_INLINE_PROFILE",
      AGMUX_HUB_URL_ENV,
      AGMUX_SESSION_ID_ENV,
      AGMUX_TMUX_SESSION_ENV,
      AGMUX_PROFILE_ENV,
    ] as const) {
```

- [ ] **Step 6: Run the wrapper tests + typecheck**

Run: `bun test packages/wrapper && bun run --filter @agmux/wrapper typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/wrapper/src/child-env.ts packages/wrapper/src/index.ts packages/wrapper/tests/child-env.test.ts
git commit -m "wrapper: inject AGMUX_PROFILE for env-gated adapter installs"
```

---

## Task 13: CLI — resume via the adapter `resumePlan` in `attach`

**Files:**
- Create: `packages/cli/src/relaunch.ts`
- Modify: `packages/cli/src/attach.ts`
- Test: `packages/cli/tests/relaunch.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/tests/relaunch.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { buildRelaunchSpec } from "../src/relaunch.ts";
import { createRegistry } from "@agmux/adapters";
import { fakeAdapter } from "@agmux/adapters/testing";
import type { SessionRow } from "@agmux/protocol";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    session_id: "sid", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: ["--foo"], env_overrides: { A: "1" }, cwd: "/work",
    pid: null, tmux_session: null, tmux_window: null, tmux_pane: null, host: "h",
    project: null, parent_session_id: null, start_ts: "t", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "ended", ...over,
  };
}

function emptyReg() { return createRegistry(); }
function fakeReg() { const r = createRegistry(); r.register(fakeAdapter); return r; }

test("no adapter, profile-backed → relaunch by profile name", () => {
  const spec = buildRelaunchSpec(row({ profile: "work" }), {
    hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: emptyReg(), baseEnv: {},
  });
  expect(spec.wrapArgv).toEqual(["agmux-wrap", "work"]);
  expect(spec.env.AGMUX_SESSION_ID).toBe("sid");
  expect(spec.env.AGMUX_HUB_URL).toBe("http://hub");
  expect(spec.env.AGMUX_INLINE_PROFILE).toBeUndefined();
});

test("no adapter, ad-hoc (no profile) → reconstruct inline profile (today's behavior)", () => {
  const spec = buildRelaunchSpec(row({ profile: null }), {
    hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: emptyReg(), baseEnv: {},
  });
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.command).toBe("claude");
  expect(inline.args).toEqual(["--foo"]);
});

test("adapter + native_session_id → relaunch with the resume argv", () => {
  const spec = buildRelaunchSpec(
    row({ profile: "work", native_session_id: "native-xyz" }),
    { hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {} },
  );
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.command).toBe("fake-cli");
  expect(inline.args).toEqual(["resume", "native-xyz"]);
});

test("adapter present but no native_session_id → falls back to normal relaunch", () => {
  const spec = buildRelaunchSpec(row({ profile: "work", native_session_id: null }), {
    hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {},
  });
  expect(spec.wrapArgv).toEqual(["agmux-wrap", "work"]); // resumePlan returned resumable:false
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/relaunch.test.ts`
Expected: FAIL — `relaunch.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/cli/src/relaunch.ts`:

```typescript
import type { SessionRow } from "@agmux/protocol";
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV } from "@agmux/protocol";
import type { Registry } from "@agmux/adapters";

export interface RelaunchSpec { wrapArgv: string[]; env: Record<string, string>; }

export interface RelaunchOpts {
  hubUrl: string;
  wrapBin: string;
  registry: Registry;
  baseEnv: Record<string, string | undefined>;
}

// Build the relaunch (command + env) for a dead/lost session. If the adapter can
// natively resume (spec §6.4) and we have a native_session_id, rewrite the inline
// profile to the resume argv; otherwise reproduce today's MVP relaunch.
export function buildRelaunchSpec(session: SessionRow, opts: RelaunchOpts): RelaunchSpec {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.baseEnv)) if (v !== undefined) env[k] = v;
  env[AGMUX_SESSION_ID_ENV] = session.session_id;
  env[AGMUX_HUB_URL_ENV] = opts.hubUrl;

  let command = session.command;
  let args = session.args;
  let cwd = session.cwd;
  let extraEnv: Record<string, string> = session.env_overrides ?? {};
  let resumed = false;

  const adapter = opts.registry.lookup(session.agent_kind);
  if (adapter && session.native_session_id) {
    const plan = adapter.resumePlan({
      agentKind: session.agent_kind, profile: session.profile,
      command: session.command, args: session.args, cwd: session.cwd,
      env: session.env_overrides ?? {}, nativeSessionId: session.native_session_id,
    });
    if (plan.resumable && plan.argv && plan.argv.length > 0) {
      command = plan.argv[0]!;
      args = plan.argv.slice(1);
      if (plan.cwd) cwd = plan.cwd;
      if (plan.env) extraEnv = { ...extraEnv, ...plan.env };
      resumed = true;
    }
  }

  // Unchanged + profile-backed → let the wrapper reload from config by name.
  if (!resumed && session.profile) {
    return { wrapArgv: [opts.wrapBin, session.profile], env };
  }

  const inlineProfile = { agent_kind: session.agent_kind, command, args, env: extraEnv, cwd };
  env.AGMUX_INLINE_PROFILE = JSON.stringify(inlineProfile);
  return { wrapArgv: [opts.wrapBin, command.split("/").pop() ?? "agent"], env };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/relaunch.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in `attach.ts`**

Replace the dead/lost relaunch section of `packages/cli/src/attach.ts` (everything from the `// dead / lost: relaunch the wrapper...` comment through the `const child = Bun.spawn(wrapArgv, {...})` construction) so it delegates to `buildRelaunchSpec`. The new `attach.ts` body after the live-switch block:

```typescript
  // dead / lost: relaunch under the same session_id, resuming natively if the
  // adapter supports it (spec §6.4). buildRelaunchSpec encapsulates the choice.
  const spec = buildRelaunchSpec(session, {
    hubUrl: opts.hubUrl,
    wrapBin: opts.wrapBin,
    registry: opts.registry ?? createDefaultRegistry(),
    baseEnv: process.env,
  });
  const child = Bun.spawn(spec.wrapArgv, {
    stdio: ["inherit", "inherit", "inherit"],
    env: spec.env,
  });
  await child.exited;
  return child.exitCode ?? 0;
```

Update the imports at the top of `attach.ts` — drop the now-unused `AGMUX_SESSION_ID_ENV`/`AGMUX_HUB_URL_ENV` if no longer referenced, and add:

```typescript
import { createDefaultRegistry, type Registry } from "@agmux/adapters";
import { buildRelaunchSpec } from "./relaunch.ts";
```

Extend `AttachOpts` to accept an optional injected registry (defaults to the real one), so tests and callers can override:

```typescript
export interface AttachOpts { idOrPrefix: string; hubUrl: string; wrapBin: string; registry?: Registry; }
```

(The `LIVE_STATUSES` import and the live-switch path stay exactly as they are.)

- [ ] **Step 6: Typecheck the CLI**

Run: `bun run --filter @agmux/cli typecheck`
Expected: no errors. (If TS flags an unused import in `attach.ts`, remove it.)

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/relaunch.ts packages/cli/src/attach.ts packages/cli/tests/relaunch.test.ts
git commit -m "cli: attach resumes natively via adapter resumePlan"
```

---

## Task 14: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck every package**

Run: `bun run typecheck`
Expected: no errors across `protocol`, `store`, `hub`, `cli`, `wrapper`, `adapters`.

- [ ] **Step 2: Run the entire test suite**

Run: `bun test`
Expected: PASS. The Phase-1 suite (111 tests) plus all new adapter/cli/wrapper tests. The new package and CLI verbs are additive; existing e2e tests must stay green.

- [ ] **Step 3: Manual smoke — emit drives status + usage end-to-end via a temporarily-registered fake adapter**

This proves the full `emit → hub → projection` path with a real hub. Because v1
ships no real adapter, temporarily register the fake one, run the smoke, then
revert (do **not** commit the temporary registration).

1. In `packages/adapters/src/adapters/index.ts`, temporarily make `registerAll` register the fake adapter:

```typescript
import type { Registry } from "../core/registry.ts";
import { fakeAdapter } from "../../tests/fixtures/fake-adapter.ts";
export function registerAll(registry: Registry): void {
  registry.register(fakeAdapter);
}
```

2. Start a hub and emit against it:

```bash
bun run --filter @agmux/hub build
# Start the hub (note its URL/port), then:
U=http://127.0.0.1:<port>
export AGMUX_HUB_URL=$U
export AGMUX_SESSION_ID=0190a3e0-0000-7000-8000-0000000000bb
# Seed a started event so the session row exists:
curl -s -XPOST $U/ingest -d '{"event_id":"01HZ7P0K8WVQH8WGS8X9DC9101","ts":"2026-05-29T10:00:00.000Z","session_id":"'$AGMUX_SESSION_ID'","kind":"session.started","version":1,"host":"h","payload":{"agent_kind":"claude","profile":null,"command":"claude","args":[],"env_overrides":{},"cwd":"/tmp","pid":1,"tmux_session":null,"tmux_window":null,"tmux_pane":null,"project":null}}'
# Drive a turn via emit (raw provider JSON on stdin):
echo '{"turn_id":"t1"}' | bun packages/cli/bin/agmux.ts emit --from=claude --source=hook-command --point=turn.started
curl -s $U/sessions/$AGMUX_SESSION_ID | grep -o '"status":"[a-z]*"'
```

Expected: `"status":"running"`.

4. **Revert the temporary registration** in `packages/adapters/src/adapters/index.ts` back to the empty body and confirm `git status` shows it clean.

- [ ] **Step 4: Confirm the working tree is clean (no smoke artifacts committed)**

Run: `git status --short`
Expected: empty (the temporary registration reverted; no stray files).

---

## Self-Review (completed by plan author)

- **Spec coverage:** §1.3 `@agmux/adapters` core + `Adapter` interface → Tasks 1–9. §2.0 capability sources → `CapabilitySource`/`ActivationMode` (Task 2) + conformance check (Task 8). §2.1 every interface member → Task 2; install/normalize/resume exercised in Tasks 7/10/13. §2.2 who-calls-what (install once; runtime emit; wrapper untouched bar two touch-points) → Tasks 7/10/12/13. §3 event contract → reuses Phase-1 protocol; `stampEvents` (Task 5) produces it. §4 `agmux emit` (dumb source/smart emit, hot-path rules, queue reuse, dedup/cursor) → Task 10. §5 projection → already landed in Phase 1 (this phase only produces the events). §6.1 profile-aware install + isolation modes → `InstallContext`/`IsolationMode` (Task 2), ledger per `(kind,profile)` (Task 7), `AGMUX_PROFILE` injection (Task 12). §6.2 capability descriptors + `session.adapter_attached` at session start → `buildAttachedEvent` (Task 6) + `emit --attach` (Task 10). §6.3 install-state ledger → Task 7. §6.4 resume → `resumePlan` (Task 2) + `buildRelaunchSpec`/`attach` (Task 13). §7 CLI verbs → Tasks 10–11. §8 touch-points table → cli/wrapper tasks. §9 per-provider follow-on → the conformance harness (Task 8) + wiring seam (Task 9) + the appendix below.
- **Deliberate spec refinements (documented above):** `InstallContext` omits `configDir`/`isolationMode` (resolved inside the adapter) to keep core provider-agnostic; `session.adapter_attached` emitted by `emit --attach` not the wrapper; resume realized in `attach.ts` not the wrapper binary. All three keep the wrapper at exactly the two touch-points the spec mandates and strengthen provider isolation.
- **Out-of-scope correctly deferred:** concrete providers, MCP, continuous sources, reconciliation daemon, pricing — none implemented.
- **Placeholder scan:** none — every code/test step shows full content; commands have expected output.
- **Type consistency:** `Adapter`/`InstallContext`/`InstallRecord`/`ResumeContext`/`ResumePlan`/`CanonicalEvent`/`NormalizeInput`/`NormalizeOutput` defined in Task 2 and used unchanged in Tasks 5–13. `stampEvents` (Task 5), `buildAttachedEvent` (Task 6), `installAdapter`/`uninstallAdapter`/`loadRecord`/`ledgerPath` (Task 7), `assertAdapterConformance` (Task 8), `createDefaultRegistry`/`registerAll` (Task 9), `runEmit`/`parseEmitArgs` (Task 10), `runAdapterCmd` (Task 11), `buildChildEnv` (Task 12), `buildRelaunchSpec` (Task 13) — names consistent across their call sites. `fakeAdapter` (Task 7) reused by Tasks 8, 10, 11, 13.

---

## Per-Provider Work Packages (follow-on — one isolated subagent each)

> This section is **not** implemented by this plan. It defines how the framework
> built above is filled in, one provider at a time, by **dedicated subagents that
> never see each other's context** — the explicit goal of this effort.

### Why this is cleanly isolatable now

The framework gives each provider exactly one self-contained slot and one objective gate:

- **One module to own:** `packages/adapters/src/adapters/<kind>/index.ts` exporting a single `Adapter`, plus `packages/adapters/tests/adapters/<kind>.test.ts`. The module imports **only** `../../core/*` — never a sibling provider.
- **One wiring line:** add `register(<kind>Adapter)` to `registerAll` in `packages/adapters/src/adapters/index.ts`.
- **One structural gate:** `assertAdapterConformance(<kind>Adapter, harness)` must pass (Task 8).
- **Provider-correctness gate:** fixture-driven `normalize()` tests using **real captured provider payloads** committed under `packages/adapters/tests/adapters/fixtures/<kind>/`. Conformance deliberately does not test normalize correctness — that is the provider subagent's job, and it needs only that provider's fixtures.

### The two-step dispatch per provider (spec §9)

1. **Challenge session** (research, no code): the subagent studies the provider's real extension architecture and produces that provider's notes — **source set** (which §2.0 source fulfils each manifest point), **capability descriptors** (§6.2 values), **isolation mode + gating** (§6.1), **`dedup_key` scheme** (§4.4), **`resumePlan` shape** (§6.4), known pitfalls, and captured raw payload fixtures. Output: `docs/superpowers/specs/<date>-adapter-<kind>-design.md`.
2. **Implementation session**: a fresh subagent implements `adapters/<kind>/` against the framework contract + that provider's design doc only, until both gates above are green.

### The self-contained brief each provider subagent receives

So a provider subagent never needs this plan's other sections or sibling code, hand it exactly:
- `packages/adapters/src/core/types.ts` (the `Adapter` interface) and `manifest.ts` (the point vocabulary).
- `packages/adapters/src/core/conformance.ts` (its acceptance gate) and `tests/fixtures/fake-adapter.ts` (a worked reference implementation).
- That provider's design doc from step 1 (and **only** that provider's).
- The rule: *import only `../../core/*`; add one line to `registerAll`; do not read or modify other adapters; commit your fixtures.*

### Known seeds (provisional — verified in each session, not committed here)

- **Codex** (spec §9.1): `env-gated` isolation (`codex -p` over shared `$CODEX_HOME`); `session.linked` + `usage.reported` via `transcript-delta` (no usage hook; native id not in hook payload); hook **stdout-as-protocol** → the silent-stdout rule already enforced in `runEmit`; plugin-vs-hook distinction with a **hook-trust** gate surfaced via `status().runtimeGate`.
- **Claude Code / Gemini (Antigravity) / opencode / pi:** source sets, isolation modes, and resume invocations TBD by their own challenge sessions.

### Suggested order

Claude Code first (richest hook surface; best exercises `config-dir` isolation and live `turn.*`), then Codex (exercises `env-gated` + `transcript-delta` + the dedup key), then the rest. Each lands independently behind its conformance gate without touching the others.
