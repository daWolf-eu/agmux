# Native-First Stage 2: Launcher Flip — Combined Spec & Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agmux run` exec the agent **directly** (no PTY wrapper) whenever the agent can self-register through its adapter plugin, keeping the wrapper as an explicit/auto fallback — and retire the wrapper-era guards that now cause false drops.

**Architecture:** Stage 1 gave the hub native identity resolution, so a directly-launched `claude` already self-registers and tracks. Stage 2 flips the launcher to use that path by default: `run` decides direct-vs-wrapped from a single pure function, ensures the adapter plugin is present before a direct exec, and scopes the two wrapper-era pollution guards (the normalize nesting guard, the projection freeze) to the wrapped/claim case where they still apply. A best-effort tmux lookup at registration fills the `ls` TMUX column for ambient sessions.

**Tech Stack:** TypeScript on Bun, bun:sqlite, `bun test`, `bun run typecheck`. Workspaces: `packages/{protocol,store,hub,cli,wrapper,adapters}`.

---

## Background (what Stage 1 already shipped)

- Events can name a session **canonically** (`session_id`) or **natively** (`identity:{agent_kind,native_session_id}`); the hub resolves native→canonical at ingest (Known / Claim / Pid-rotation / Mint).
- The Claude plugin (v1.2.0) emits `session.registered` from `SessionStart` with the native id + pid (`$PPID`).
- `emit` discovers the hub via `~/.agmux/hub.port` when `AGMUX_HUB_URL` is absent (the ambient case).
- Hub pid-sweep marks dead native pids `lost`; `computeEffectiveStatus` is origin-aware.

What Stage 1 did **not** change: `agmux run` still always interposes the PTY wrapper. Stage 2 is that flip.

## Design

### D1. Launch-mode decision (the flip)

`agmux run <agent>` chooses between two launch modes:

| Condition | Mode | Why |
|---|---|---|
| `--wrapped` given | **wrapped** | explicit opt-in (PTY features, heartbeat liveness) |
| agent kind has **no adapter** | **wrapped** (auto) | can't self-register → wrapper is the only way to track it |
| otherwise (adapter present) | **direct** | the plugin self-registers; no PTY needed |

This is a pure function of `{ wrapped: boolean, hasAdapter: boolean }` so it is unit-testable in isolation. `run` resolves `hasAdapter` from `registry.lookup(agent_kind)`.

**Direct exec** runs the real agent binary in the target tmux location with telemetry env (`AGMUX_BIN`, profile name) but **no** `AGMUX_SESSION_ID` claim — the agent self-registers under its own native id. **Wrapped** is exactly today's `agmux-wrap` path, unchanged.

### D2. Adapter readiness gates direct exec — but `run` never installs without consent

Native tracking only works if the plugin is installed, but `agmux run` **must not write to the user's Claude config without explicit consent.** So direct exec only *checks* readiness — it never installs:

- Plugin installed and current (`status().installed && !status().drift`) → proceed direct.
- Plugin missing or drifted → print a one-line hint naming the install command, and **fall back to the wrapper for this launch.** Wrapped keeps the session tracked (PTY heartbeat) and touches no config.

The documented `agmux adapter install --kind <kind>` command *is* the consent path: the user runs it explicitly when they want native tracking. No in-run prompt — `run` often hands off into a tmux pane or detaches, where an interactive prompt is unreliable; the hint + wrapped fallback is the robust, consent-clean behavior.

### D3. Nesting guard → scoped to claim (wrapped) sessions

`normalizeClaude` currently drops **all** events when `env.CLAUDE_CODE_SESSION_ID !== raw.session_id`. That guard exists to stop a nested `claude` (spawned by an outer wrapped session's hook, inheriting the outer `AGMUX_SESSION_ID`) from mislabeling events into the outer session.

In direct exec there is **no** `AGMUX_SESSION_ID` claim — every `claude` (including sub-agents and nested runs) self-registers under its own native id, and the hub's mint/pid-rotation rules give each its own canonical session with correct lineage. The blanket guard now only produces **false drops** for legitimate sub-agent sessions.

**Change:** the guard fires **only when a claim is present** (`env.AGMUX_SESSION_ID` set). With a claim (wrapped mode) the env-vs-stdin mismatch still means "a nested run inheriting my claim" → drop. Without a claim (direct/native) the guard is inert and sub-agent events pass through.

### D4. Projection freeze → wrapped-origin only

`isEnded` freezes identity/usage refinements after `session.ended` to stop a SessionEnd-hook summarizer (`claude -p` inheriting the wrapped claim) from polluting a dead session. That leak only exists for **wrapped/claim** sessions. Native sessions legitimately reopen on re-`session.registered` (already implemented in `applyRegistered`'s ended/lost branch) and never receive a `session.ended` (no wrapper to emit it).

**Change:** the freeze applies only to `origin = 'wrapper'` rows. Rename the helper to `isFrozen(db, sid)` = `status == 'ended' AND origin == 'wrapper'`. Native rows are never frozen, so a resumed ambient session keeps refining cleanly.

### D5. tmux coords at registration (fills the `ls` TMUX column)

`session.registered` payloads carry `tmux_session = null, tmux_window = null` today, so `ls` shows `-` in the TMUX column for ambient sessions. `emit` enriches `session.registered` envelopes with resolved coords via a best-effort, short-timeout tmux lookup keyed on `$TMUX_PANE` (`tmux display-message -p -t <pane> '#{session_name}\t#{window_id}'`). Failure (no tmux, timeout) leaves the fields null — never throws, never blocks the hot path. Fires once per registration, so the cost is acceptable.

### Out of scope — separate future cycles

These are **explicitly not** Stage 2. Each gets its own spec → plan → implementation cycle when requested:

- **Additional adapters (Codex and any other provider).** Provider onboarding is its own cycle: adapter caps, normalize, install, plugin payload, and live-fire verification per provider. Stage 2 touches only the launcher and the Claude adapter's guard.
- **Synthetic `session.resumed` on the native reopen branch.** The reopen is already observable through the `session.registered` event in the append-only log; a separate synthetic event is YAGNI for now.
- **Removing the wrapper entirely.** The wrapper stays as the `--wrapped`/auto-wrap fallback indefinitely.

## File Structure

- **Create** `packages/cli/src/launch-mode.ts` — pure `decideLaunchMode()` + `LaunchMode` type. One responsibility: the direct-vs-wrapped decision.
- **Create** `packages/cli/src/adapter-ready.ts` — `adapterReadyOrHint()` (readiness check + hint; **never installs**). Keeps the consent policy out of `run.ts`.
- **Modify** `packages/cli/src/parse-run.ts` — add `wrapped: boolean` to the profile and inline `ParsedRun` variants; parse `--wrapped`.
- **Modify** `packages/cli/src/run.ts` — add the direct-exec spawn path (inline current-pane + reuse placements); resolve profiles for direct mode; `RunOpts` gains `mode`.
- **Modify** `packages/cli/src/tmux-place.ts` — add injectable `resolvePaneCoords(paneId, exec?)`.
- **Modify** `packages/cli/src/emit.ts` — enrich `session.registered` with tmux coords (injectable `resolveTmux`).
- **Modify** `packages/cli/bin/agmux.ts` — compute `hasAdapter`, call `decideLaunchMode`, `ensureAdapterInstalled` for direct, pass `mode`; wire `--wrapped` into usage.
- **Modify** `packages/adapters/src/adapters/claude/normalize.ts` — scope the nesting guard to claim presence.
- **Modify** `packages/store/src/project.ts` — `isEnded` → origin-aware `isFrozen`.
- **Modify** `docs/agmux-foundation.md` — annotate §4/§5 launcher notes as realized by Stage 2.

---

## Task 1: `--wrapped` flag in run parsing

**Files:**
- Modify: `packages/cli/src/parse-run.ts`
- Test: `packages/cli/tests/parse-run.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { test, expect } from "bun:test";
import { parseRunArgs } from "../src/parse-run.ts";

test("inline run defaults wrapped:false", () => {
  const r = parseRunArgs(["claude"]);
  expect(r).toMatchObject({ kind: "inline", agent_kind: "claude", wrapped: false });
});

test("--wrapped sets wrapped:true (inline)", () => {
  const r = parseRunArgs(["--wrapped", "claude"]);
  expect(r).toMatchObject({ kind: "inline", wrapped: true });
});

test("--wrapped sets wrapped:true (profile)", () => {
  const r = parseRunArgs(["--wrapped", "-p", "work"]);
  expect(r).toMatchObject({ kind: "profile", profileName: "work", wrapped: true });
});

test("--wrapped composes with placement", () => {
  const r = parseRunArgs(["--new-window", "--wrapped", "claude"]);
  expect(r).toMatchObject({ kind: "inline", placement: "new-window", wrapped: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/tests/parse-run.test.ts`
Expected: FAIL — `wrapped` undefined on results.

- [ ] **Step 3: Implement**

In `packages/cli/src/parse-run.ts`, extend the union and parse the flag:

```typescript
export type ParsedRun =
  | { kind: "profile"; profileName: string; placement: Placement; detach: boolean; wrapped: boolean }
  | { kind: "inline"; agent_kind: "claude" | "codex"; command: string; args: string[]; placement: Placement; detach: boolean; wrapped: boolean }
  | { kind: "error"; message: string };
```

Add a `wrapped` local (default `false`) in `parseRunArgs`, and a flag branch inside the `while` loop (alongside `-d/--detach`):

```typescript
    if (a === "--wrapped") { wrapped = true; i += 1; continue; }
```

Thread `wrapped` into both returned objects:

```typescript
    return { kind: "profile", profileName, placement, detach, wrapped };
```
```typescript
  return { kind: "inline", agent_kind, command, args, placement, detach, wrapped };
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/cli/tests/parse-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter '@agmux/cli' typecheck`
Expected: clean.

```bash
git add packages/cli/src/parse-run.ts packages/cli/tests/parse-run.test.ts
git commit -m "cli: parse --wrapped flag for run"
```

---

## Task 2: Launch-mode decision function

**Files:**
- Create: `packages/cli/src/launch-mode.ts`
- Test: `packages/cli/tests/launch-mode.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { test, expect } from "bun:test";
import { decideLaunchMode } from "../src/launch-mode.ts";

test("adapter present, not --wrapped → direct", () => {
  expect(decideLaunchMode({ wrapped: false, hasAdapter: true })).toBe("direct");
});

test("--wrapped forces wrapped even with adapter", () => {
  expect(decideLaunchMode({ wrapped: true, hasAdapter: true })).toBe("wrapped");
});

test("no adapter auto-wraps", () => {
  expect(decideLaunchMode({ wrapped: false, hasAdapter: false })).toBe("wrapped");
});

test("no adapter + --wrapped → wrapped", () => {
  expect(decideLaunchMode({ wrapped: true, hasAdapter: false })).toBe("wrapped");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/tests/launch-mode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/launch-mode.ts
// The Stage 2 flip: a session that can self-register (has an adapter) runs
// directly; everything else (or an explicit --wrapped) goes through the PTY
// wrapper. See docs/superpowers/plans/2026-06-09-native-first-stage2.md §D1.
export type LaunchMode = "direct" | "wrapped";

export function decideLaunchMode(o: { wrapped: boolean; hasAdapter: boolean }): LaunchMode {
  if (o.wrapped) return "wrapped";      // explicit opt-in
  if (!o.hasAdapter) return "wrapped";  // can't self-register → must wrap
  return "direct";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/cli/tests/launch-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launch-mode.ts packages/cli/tests/launch-mode.test.ts
git commit -m "cli: add decideLaunchMode (direct vs wrapped)"
```

---

## Task 3: Scope the Claude nesting guard to claim sessions

**Files:**
- Modify: `packages/adapters/src/adapters/claude/normalize.ts:22-23`
- Test: `packages/adapters/tests/claude-normalize.test.ts` (add cases; create if absent)

- [ ] **Step 1: Write the failing tests**

```typescript
import { test, expect } from "bun:test";
import { normalizeClaude } from "../src/adapters/claude/normalize.ts";

const base = {
  point: "session.registered" as const,
  source: "hook-command" as const,
  cursor: null,
  target: { agentKind: "claude" as const, profile: null },
  raw: { session_id: "inner-123", cwd: "/tmp" },
};

test("claim present + env/stdin mismatch → dropped (wrapped guard holds)", () => {
  const out = normalizeClaude({
    ...base,
    env: { AGMUX_SESSION_ID: "claimed", CLAUDE_CODE_SESSION_ID: "outer-999" },
  });
  expect(out.events).toHaveLength(0);
});

test("no claim + env/stdin mismatch → passes (direct sub-agent tracked)", () => {
  const out = normalizeClaude({
    ...base,
    env: { CLAUDE_CODE_SESSION_ID: "outer-999" }, // no AGMUX_SESSION_ID
  });
  expect(out.events).toHaveLength(1);
  expect(out.events[0]!.payload).toMatchObject({ native_session_id: "inner-123" });
});

test("claim present + env matches stdin → passes", () => {
  const out = normalizeClaude({
    ...base,
    env: { AGMUX_SESSION_ID: "claimed", CLAUDE_CODE_SESSION_ID: "inner-123" },
  });
  expect(out.events).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/adapters/tests/claude-normalize.test.ts`
Expected: FAIL — the no-claim mismatch case currently drops (0 events) but the test expects 1.

- [ ] **Step 3: Implement**

In `normalizeClaude`, replace the guard (lines 16-23) with a claim-scoped version:

```typescript
  // Nesting guard (Stage 2 §D3): only meaningful when a wrapper CLAIM is in play.
  // With a claim, an env-vs-stdin mismatch means a nested `claude` inherited our
  // AGMUX_SESSION_ID — drop it rather than pollute the claimed session. Without a
  // claim (direct/native exec) every run self-registers under its own native id,
  // so the mismatch is a legitimate sub-agent and must pass through.
  const claim = input.env?.AGMUX_SESSION_ID;
  const envSid = input.env?.CLAUDE_CODE_SESSION_ID;
  if (claim && envSid && raw.session_id && envSid !== raw.session_id) return { events: [] };
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/adapters/tests/claude-normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter '@agmux/adapters' typecheck`

```bash
git add packages/adapters/src/adapters/claude/normalize.ts packages/adapters/tests/claude-normalize.test.ts
git commit -m "adapters: scope claude nesting guard to claim sessions"
```

---

## Task 4: Origin-aware projection freeze

**Files:**
- Modify: `packages/store/src/project.ts:139-144` (and call sites)
- Test: `packages/store/tests/project-freeze.test.ts` (add a native case; create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { Store } from "../src/index.ts";

function reg(store: Store, nat: string, eid: string, ts: string) {
  store.resolveAndAppend({
    event_id: eid, ts, kind: "session.registered", version: 1, host: "h",
    identity: { agent_kind: "claude", native_session_id: nat },
    payload: { agent_kind: "claude", native_session_id: nat, pid: 100, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: null, profile: null, agent_version: null, parent: null },
  } as any);
}

test("native ended-then-usage is NOT frozen (origin native reopens cleanly)", () => {
  const store = Store.openInMemory();
  reg(store, "nat-1", "01HZ000000000000000000000A", "2026-06-09T10:00:00.000Z");
  const sid = store.listSessions({}).find((s) => s.native_session_id === "nat-1")!.session_id;
  // Force the row to 'ended' to prove origin (not status) gates the freeze.
  store.append({ event_id: "01HZ000000000000000000000B", ts: "2026-06-09T10:01:00.000Z",
    session_id: sid, kind: "session.ended", version: 1, host: "h",
    payload: { exit_code: 0, signal: null, reason: "normal" } } as any);
  store.append({ event_id: "01HZ000000000000000000000C", ts: "2026-06-09T10:02:00.000Z",
    session_id: sid, kind: "usage.reported", version: 1, host: "h",
    payload: { cumulative: false, source: "manual-command", input_tokens: 7 } } as any);
  expect(store.getSessionUsage(sid)!.input_tokens).toBe(7); // not frozen
  store.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/store/tests/project-freeze.test.ts`
Expected: FAIL — current `isEnded` freezes regardless of origin, so usage stays 0.

- [ ] **Step 3: Implement**

In `packages/store/src/project.ts`, replace `isEnded` with an origin-aware `isFrozen` and update its two call sites (`applyUsage`, `bumpTurnCount`):

```typescript
// A WRAPPER session is FROZEN after session.ended: identity/usage refinements are
// dropped so a SessionEnd-hook summarizer (`claude -p` inheriting the claim) can't
// pollute the dead session. NATIVE rows are never frozen — they legitimately
// reopen on re-registration (applyRegistered) and never receive session.ended.
// (Stage 2 §D4.)
function isFrozen(db: Database, sessionId: string): boolean {
  const row = db.query<{ status: string; origin: string }, [string]>(
    `SELECT status, origin FROM sessions WHERE session_id = ?`,
  ).get(sessionId);
  return row?.status === "ended" && row?.origin === "wrapper";
}
```

Update both guards from `if (isEnded(db, ev.session_id)) return;` to `if (isFrozen(db, ev.session_id)) return;` (in `bumpTurnCount` and `applyUsage`).

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/store/` (the whole store suite — confirm wrapper-freeze tests still pass)
Expected: PASS, including any existing wrapper-origin freeze test.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter '@agmux/store' typecheck`

```bash
git add packages/store/src/project.ts packages/store/tests/project-freeze.test.ts
git commit -m "store: scope projection freeze to wrapper-origin sessions"
```

---

## Task 5: Injectable tmux pane-coords resolver

**Files:**
- Modify: `packages/cli/src/tmux-place.ts`
- Test: `packages/cli/tests/tmux-place.test.ts` (add cases; create if absent)

- [ ] **Step 1: Write the failing tests**

```typescript
import { test, expect } from "bun:test";
import { resolvePaneCoords } from "../src/tmux-place.ts";

test("parses session_name<TAB>window_id from tmux", async () => {
  const fakeExec = async (_args: string[]) => "agmux\t@4\n";
  expect(await resolvePaneCoords("%7", fakeExec)).toEqual({ session: "agmux", window: "@4" });
});

test("returns null on exec failure", async () => {
  const fakeExec = async () => { throw new Error("no tmux"); };
  expect(await resolvePaneCoords("%7", fakeExec)).toBeNull();
});

test("returns null on malformed output", async () => {
  const fakeExec = async () => "garbage\n";
  expect(await resolvePaneCoords("%7", fakeExec)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/tests/tmux-place.test.ts`
Expected: FAIL — `resolvePaneCoords` not exported.

- [ ] **Step 3: Implement**

Add to `packages/cli/src/tmux-place.ts`:

```typescript
// Best-effort lookup of a pane's session+window for session.registered enrichment
// (Stage 2 §D5). Injectable exec keeps it unit-testable; the default shells out
// to tmux. Returns null on any failure — callers must treat coords as optional.
export type TmuxExec = (args: string[]) => Promise<string>;

const defaultTmuxExec: TmuxExec = async (args) => {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`tmux exit ${proc.exitCode}`);
  return out;
};

export async function resolvePaneCoords(
  paneId: string,
  exec: TmuxExec = defaultTmuxExec,
): Promise<{ session: string; window: string } | null> {
  try {
    const out = await exec(["display-message", "-p", "-t", paneId, "#{session_name}\t#{window_id}"]);
    const [session, window] = out.trim().split("\t");
    if (!session || !window) return null;
    return { session, window };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/cli/tests/tmux-place.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter '@agmux/cli' typecheck`

```bash
git add packages/cli/src/tmux-place.ts packages/cli/tests/tmux-place.test.ts
git commit -m "cli: add injectable resolvePaneCoords tmux helper"
```

---

## Task 6: Enrich `session.registered` with tmux coords in emit

**Files:**
- Modify: `packages/cli/src/emit.ts`
- Test: `packages/cli/tests/emit.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { enrichTmuxCoords } from "../src/emit.ts";

test("fills tmux_session/window on session.registered when pane resolves", async () => {
  const events = [{ kind: "session.registered", payload: { tmux_session: null, tmux_window: null, tmux_pane: "%7" } }] as any;
  await enrichTmuxCoords(events, { TMUX_PANE: "%7" }, async () => ({ session: "agmux", window: "@4" }));
  expect(events[0].payload).toMatchObject({ tmux_session: "agmux", tmux_window: "@4" });
});

test("leaves coords null when resolver returns null", async () => {
  const events = [{ kind: "session.registered", payload: { tmux_session: null, tmux_window: null, tmux_pane: "%7" } }] as any;
  await enrichTmuxCoords(events, { TMUX_PANE: "%7" }, async () => null);
  expect(events[0].payload).toMatchObject({ tmux_session: null, tmux_window: null });
});

test("no-ops when not in tmux (no TMUX_PANE)", async () => {
  const events = [{ kind: "session.registered", payload: { tmux_session: null, tmux_window: null, tmux_pane: null } }] as any;
  await enrichTmuxCoords(events, {}, async () => ({ session: "x", window: "@1" }));
  expect(events[0].payload).toMatchObject({ tmux_session: null, tmux_window: null });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/tests/emit.test.ts`
Expected: FAIL — `enrichTmuxCoords` not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/emit.ts`, import the resolver type and add the helper:

```typescript
import { resolvePaneCoords, type TmuxExec } from "./tmux-place.ts";
```

```typescript
// Fill tmux_session/window on session.registered payloads (Stage 2 §D5). Best
// effort: fires once per registration, never throws, leaves coords null on miss.
export async function enrichTmuxCoords(
  events: Array<{ kind: string; payload: any }>,
  env: Record<string, string | undefined>,
  resolve: (paneId: string) => Promise<{ session: string; window: string } | null>,
): Promise<void> {
  const pane = env.TMUX_PANE;
  if (!pane) return;
  const reg = events.filter((e) => e.kind === "session.registered" && e.payload && e.payload.tmux_session == null);
  if (reg.length === 0) return;
  const coords = await resolve(pane);
  if (!coords) return;
  for (const e of reg) { e.payload.tmux_session = coords.session; e.payload.tmux_window = coords.window; }
}
```

Add an optional `resolveTmux?: TmuxExec` to `EmitDeps`, and call the enrichment in `runEmit` after `stampIngestEvents`, before `postOrQueue`:

```typescript
    const stamped = stampIngestEvents(events, {
      agentKind: a.from as AgentKind, nativeId, claimId, host: deps.host, now: deps.now, newId: deps.newId,
    });
    await enrichTmuxCoords(stamped as any, deps.env, (pane) => resolvePaneCoords(pane, deps.resolveTmux));
    await postOrQueue(stamped, { /* unchanged */ });
```

(The whole body is already inside `runEmit`'s `try/catch`, so an unexpected throw still cannot break the agent.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/cli/tests/emit.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter '@agmux/cli' typecheck`

```bash
git add packages/cli/src/emit.ts packages/cli/tests/emit.test.ts
git commit -m "cli: enrich session.registered with tmux coords"
```

---

## Task 7: Adapter-readiness check (consent-clean — never installs)

**Files:**
- Create: `packages/cli/src/adapter-ready.ts`
- Test: `packages/cli/tests/adapter-ready.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { test, expect } from "bun:test";
import { adapterReadyOrHint } from "../src/adapter-ready.ts";

function fakeAdapter(state: { installed: boolean; drift: boolean }) {
  const calls = { install: 0, status: 0 };
  const adapter = {
    status: () => { calls.status++; return { installed: state.installed, version: "1", drift: state.drift, runtimeGate: "none" as const }; },
    install: () => { calls.install++; return {} as any; },
  } as any;
  return { adapter, calls };
}
const ctx = {} as any;

test("ready when installed and current — no hint, never installs", () => {
  const { adapter, calls } = fakeAdapter({ installed: true, drift: false });
  const lines: string[] = [];
  expect(adapterReadyOrHint(adapter, ctx, "claude", (s) => lines.push(s))).toBe(true);
  expect(calls.install).toBe(0);
  expect(lines).toHaveLength(0);
});

test("not installed → hint, returns false, NEVER installs", () => {
  const { adapter, calls } = fakeAdapter({ installed: false, drift: false });
  const lines: string[] = [];
  expect(adapterReadyOrHint(adapter, ctx, "claude", (s) => lines.push(s))).toBe(false);
  expect(calls.install).toBe(0);
  expect(lines.join("\n")).toContain("agmux adapter install --kind claude");
});

test("drifted → hint, returns false, never installs", () => {
  const { adapter, calls } = fakeAdapter({ installed: true, drift: true });
  const lines: string[] = [];
  expect(adapterReadyOrHint(adapter, ctx, "claude", (s) => lines.push(s))).toBe(false);
  expect(calls.install).toBe(0);
  expect(lines.join("\n")).toContain("agmux adapter install --kind claude");
});

test("status throws → not ready, swallowed (no throw)", () => {
  const adapter = { status: () => { throw new Error("boom"); } } as any;
  expect(adapterReadyOrHint(adapter, ctx, "claude", () => {})).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/tests/adapter-ready.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/adapter-ready.ts
import type { Adapter, InstallContext, AgentKind } from "@agmux/adapters";

// Direct exec needs the plugin present, but `agmux run` MUST NOT write the user's
// Claude config without consent (Stage 2 §D2). So we only CHECK: if the plugin is
// missing/drifted, emit a one-line hint (the documented install command IS the
// consent path) and report not-ready, so the caller falls back to wrapped. Never
// installs, never throws.
export function adapterReadyOrHint(
  adapter: Adapter,
  ctx: InstallContext,
  kind: AgentKind,
  out: (line: string) => void,
): boolean {
  let st;
  try { st = adapter.status(ctx); } catch { return false; }
  if (st.installed && !st.drift) return true;
  const what = st.drift ? "outdated" : "not installed";
  out(`agmux: ${kind} adapter ${what} — native tracking off. Enable it with: agmux adapter install --kind ${kind}  (launching wrapped for now)`);
  return false;
}
```

(If `Adapter`/`InstallContext`/`AgentKind` are not re-exported from `@agmux/adapters`, verify with `grep -n "InstallContext\|export type Adapter\|AgentKind" packages/adapters/src/index.ts`; `AgentKind` is from `@agmux/protocol` and may be imported from there instead. Add `export type { Adapter, InstallContext } from "./core/types.ts";` to the adapters `index.ts` if missing.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/cli/tests/adapter-ready.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter '@agmux/cli' typecheck`

```bash
git add packages/cli/src/adapter-ready.ts packages/cli/tests/adapter-ready.test.ts packages/adapters/src/index.ts
git commit -m "cli: add adapterReadyOrHint (no install without consent)"
```

---

## Task 8: Direct-exec launch path in run.ts

**Files:**
- Modify: `packages/cli/src/run.ts`
- Test: `packages/cli/tests/run.test.ts` (add direct-spawn-shape cases; create if absent)

The direct path reuses the existing tmux placement helpers; only the command and env change (real agent binary instead of `agmux-wrap`, telemetry env without a claim).

- [ ] **Step 1: Write the failing test (command/env shape)**

```typescript
import { test, expect } from "bun:test";
import { buildDirectSpawn } from "../src/run.ts";

test("inline direct spawn uses the agent command + telemetry env, no claim", () => {
  const s = buildDirectSpawn({
    kind: "inline", mode: "direct", agent_kind: "claude", command: "claude", args: ["--foo"],
    hubUrl: "http://127.0.0.1:9", wrapBin: "agmux-wrap", placement: "inherit", detach: false, wrapped: false,
  } as any, "/usr/local/bin/agmux");
  expect(s.argv).toEqual(["claude", "--foo"]);
  expect(s.env.AGMUX_BIN).toBe("/usr/local/bin/agmux");
  expect(s.env.AGMUX_SESSION_ID).toBeUndefined(); // native: no claim
  expect(s.label).toBe("claude");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/tests/run.test.ts`
Expected: FAIL — `buildDirectSpawn` not exported.

- [ ] **Step 3: Implement**

Add `mode: LaunchMode` to `RunProfileOpts` and `RunInlineOpts` in `run.ts` (import `LaunchMode` from `./launch-mode.ts`), and a `buildDirectSpawn` parallel to `buildWrapperSpawn`. For profile mode, resolve the command via `loadProfile`:

```typescript
import { loadProfile } from "@agmux/wrapper";
import * as os from "node:os";
import * as path from "node:path";
import { AGMUX_CONFIG_SUBPATH, AGMUX_PROFILE_ENV } from "@agmux/protocol";
import type { LaunchMode } from "./launch-mode.ts";
```

```typescript
// Direct exec (Stage 2): run the real agent binary. Telemetry env carries AGMUX_BIN
// (so the plugin shim resolves agmux) and the profile name, but NO AGMUX_SESSION_ID
// claim — the agent self-registers under its own native id.
export function buildDirectSpawn(opts: RunOpts, agmuxBin: string): WrapperSpawn {
  const env: Record<string, string> = {
    [AGMUX_HUB_URL_ENV]: opts.hubUrl,
    AGMUX_BIN: agmuxBin,
  };
  if (opts.kind === "profile") {
    const cfgPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
    const p = loadProfile(opts.profileName, cfgPath);
    env[AGMUX_PROFILE_ENV] = opts.profileName;
    return { argv: [p.command, ...p.args], env, label: opts.profileName };
  }
  const label = opts.command.split("/").pop() ?? "agent";
  return { argv: [opts.command, ...opts.args], env, label };
}
```

Route by mode. In `buildWrapperSpawn`'s callers, choose the spawn builder; the bin arg is the running agmux path (`process.execPath` is bun, so pass `process.env.AGMUX_BIN ?? "agmux"` from the binary — see Task 9). Update `runInherit` and `runWithPlacement` to select the builder:

```typescript
function spawnFor(opts: RunOpts, agmuxBin: string): WrapperSpawn {
  return opts.mode === "direct" ? buildDirectSpawn(opts, agmuxBin) : buildWrapperSpawn(opts);
}
```

For direct mode the executable is the agent itself, not `wrapBin`. Generalize the spawn to take the executable from `argv[0]`:
- In `runInherit`: `const [exe, ...rest] = opts.mode === "direct" ? spawnFor(opts, agmuxBin).argv : [opts.wrapBin, ...buildWrapperSpawn(opts).argv]`. Simplest: have `spawnFor` always return a full argv whose `argv[0]` is the executable (for wrapped, prepend `opts.wrapBin`). Refactor `WrapperSpawn.argv` to be the **complete** argv (executable first) for both modes, and spawn `Bun.spawn(spawn.argv, …)`. Update `buildWrapperSpawn` to prepend `opts.wrapBin`:

```typescript
function buildWrapperSpawn(opts: RunOpts): WrapperSpawn {
  const env: Record<string, string> = { [AGMUX_HUB_URL_ENV]: opts.hubUrl };
  if (opts.kind === "profile") {
    return { argv: [opts.wrapBin, opts.profileName], env, label: opts.profileName };
  }
  const inlineProfile = { agent_kind: opts.agent_kind, command: opts.command, args: opts.args, env: {} };
  const label = opts.command.split("/").pop() ?? "agent";
  env.AGMUX_INLINE_PROFILE = JSON.stringify(inlineProfile);
  return { argv: [opts.wrapBin, label], env, label };
}
```

and make `buildDirectSpawn`'s `argv` already executable-first (it is). Then `runInherit`/`runWithPlacement` use `spawn.argv` directly as the command (drop the `[opts.wrapBin, ...spawn.argv]` prefix). Pass `agmuxBin` into `runCmd` → `spawnFor`.

`runCmd` signature gains `agmuxBin`:

```typescript
export async function runCmd(opts: RunOpts, agmuxBin: string): Promise<number> {
  if (opts.placement === "inherit") {
    // Direct + not in tmux → fall back to a fresh agmux session so the agent is
    // still tmux-tracked; otherwise run inline in the current pane.
    if (opts.mode === "direct" && !(await readCurrentPane())) {
      return runWithPlacement({ ...opts, placement: "new-session" }, agmuxBin);
    }
    return runInherit(opts, agmuxBin);
  }
  return runWithPlacement(opts, agmuxBin);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/cli/tests/run.test.ts`
Expected: PASS.

- [ ] **Step 5: Full CLI suite + typecheck + commit**

Run: `bun test packages/cli/` then `bun run --filter '@agmux/cli' typecheck`
Expected: PASS / clean (fix any callers of `runCmd`/`buildWrapperSpawn` broken by the argv refactor — `bin/agmux.ts` is updated in Task 9).

```bash
git add packages/cli/src/run.ts packages/cli/tests/run.test.ts
git commit -m "cli: add direct-exec launch path to run"
```

---

## Task 9: Wire the flip into the CLI entrypoint

**Files:**
- Modify: `packages/cli/bin/agmux.ts`
- Verify: manual run (covered in Task 10)

- [ ] **Step 1: Implement**

In `bin/agmux.ts`, the `run` case computes `hasAdapter`, decides the mode, ensures the adapter (direct only), and passes `mode` + `agmuxBin`:

```typescript
import { decideLaunchMode } from "../src/launch-mode.ts";
import { adapterReadyOrHint } from "../src/adapter-ready.ts";
```

```typescript
    case "run": {
      const parsed = parseRunArgs(argv.slice(1));
      if (parsed.kind === "error") { console.error(parsed.message); return 2; }

      const registry = createDefaultRegistry();
      const agmuxBin = process.env.AGMUX_BIN ?? "agmux";
      const kind = parsed.kind === "inline" ? parsed.agent_kind : undefined;
      // For profile mode the agent_kind is in the profile; resolve adapter presence
      // by kind when known, else assume present (profile implies a known provider).
      const adapter = kind ? registry.lookup(kind) : registry.lookup("claude");
      let mode = decideLaunchMode({ wrapped: parsed.wrapped, hasAdapter: !!adapter });

      // Direct exec needs the plugin present; we NEVER install without consent.
      // If it isn't ready, adapterReadyOrHint prints the install hint and we fall
      // back to wrapped (tracked, no config writes). (§D2.)
      if (mode === "direct" && adapter) {
        const ready = adapterReadyOrHint(adapter, {
          agentKind: (kind ?? "claude"),
          profile: parsed.kind === "profile" ? parsed.profileName : null,
          profileEnv: {},
          agmuxEmitPath: `${agmuxBin} emit`,
          stateDir,
          configDirOverride: null,
        }, (kind ?? "claude"), (s) => console.error(s));
        if (!ready) mode = "wrapped";
      }

      const common = { placement: parsed.placement, detach: parsed.detach, hubUrl, wrapBin, mode } as const;
      if (parsed.kind === "profile") {
        return runCmd({ kind: "profile", profileName: parsed.profileName, ...common }, agmuxBin);
      }
      return runCmd({
        kind: "inline", agent_kind: parsed.agent_kind, command: parsed.command, args: parsed.args, ...common,
      }, agmuxBin);
    }
```

Update the usage block to document `--wrapped`:

```typescript
  run [placement] [--wrapped] [--kind=<claude|codex>] <command> [args...]
```
```
    --wrapped                force the PTY wrapper (default: direct exec when the agent has an adapter)
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@agmux/cli' typecheck`
Expected: clean.

- [ ] **Step 3: Build the CLI binary**

Run: `cd packages/cli && bun build --compile ./bin/agmux.ts --outfile dist/agmux && cd ../..`
Expected: builds `packages/cli/dist/agmux`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/bin/agmux.ts
git commit -m "cli: launch direct by default, --wrapped to force wrapper"
```

---

## Task 10: Docs + full-suite gate + live verification

**Files:**
- Modify: `docs/agmux-foundation.md` (§4/§5 launcher notes)

- [ ] **Step 1: Update foundation doc**

In `docs/agmux-foundation.md`, under the §4/§5 native-first annotations, add a line that Stage 2 realized the launcher flip: `agmux run` direct-execs adapter-backed agents; the wrapper is the `--wrapped`/auto fallback; the nesting guard and projection freeze are now wrapped/claim-scoped.

- [ ] **Step 2: Full suite + typecheck**

Run: `bun test` then `bun run --filter '*' typecheck`
Expected: all pass, typecheck clean across every package.

- [ ] **Step 3: Live verification (real binaries, isolated HOME)**

Build all three binaries, install into a temp HOME, and confirm a direct `agmux run claude` self-registers and shows tmux coords:

```bash
# build
for p in cli hub wrapper; do (cd packages/$p && bun build --compile ./bin/agmux*.ts --outfile dist/$(ls bin | sed 's/\.ts//')); done
```

Then, inside a tmux session, run the compiled `agmux run claude`, send one prompt, and verify with `agmux ls --all`:
- the row appears with `origin = native` (check `agmux inspect <id>`),
- `STATUS` transitions idle→running→idle,
- the `TMUX` column shows `session:window` (not `-`),
- no `agmux-wrap` process exists for it (`pgrep -af agmux-wrap`).

Then confirm the fallback: `agmux run --kind=codex codex` (no Codex adapter) → a wrapped session (an `agmux-wrap` process exists). And `agmux run --wrapped claude` → wrapped despite the adapter.

- [ ] **Step 4: Commit docs**

```bash
git add docs/agmux-foundation.md
git commit -m "docs: note Stage 2 launcher flip in foundation"
```

---

## Self-Review

**Spec coverage:** D1 → Tasks 1,2,8,9. D2 → Tasks 7,9. D3 → Task 3. D4 → Task 4. D5 → Tasks 5,6. Docs → Task 10. Every design point maps to a task.

**Out-of-scope honored:** No Codex/provider work; no synthetic `session.resumed`; wrapper retained. Codex appears only as a *fallback* test case (no adapter → auto-wrap), not as new adapter code.

**Type consistency:** `decideLaunchMode({wrapped,hasAdapter})→LaunchMode`; `RunOpts` gains `mode: LaunchMode`; `WrapperSpawn.argv` becomes executable-first for both modes (Task 8 refactor — verify all `buildWrapperSpawn`/`runCmd` callers updated); `resolvePaneCoords(paneId, exec?)→{session,window}|null`; `enrichTmuxCoords(events,env,resolve)`; `isFrozen(db,sid)` replaces `isEnded` at both call sites; `adapterReadyOrHint(adapter,ctx,kind,out)→boolean` (never installs).

**Open decision surfaced for review:**
1. **Profile-mode adapter presence (Task 9):** profile mode assumes a known provider (looks up `claude`) since the kind lives in the profile config. If profiles can name adapter-less kinds, Task 9 should load the profile to read `agent_kind` first.
