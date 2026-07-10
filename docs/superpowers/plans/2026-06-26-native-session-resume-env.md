# Native-Session Resume Env Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a natively-launched agent session with the config-affecting env it ran with (e.g. `CLAUDE_CONFIG_DIR`), so `claude --resume <id>` finds the conversation instead of failing with "No conversation found".

**Architecture:** Two complementary mechanisms. (A) Each adapter declares an allowlist of relaunch-critical env keys (`relaunchEnvKeys`); the hook captures *only* those keys at `session.registered` and the store persists them into the session row's `env_json` — mirroring what wrapper sessions already store from `profile.env`. (B) `AGMUX_PROFILE` (set by the user on a native launch) ties the session to a profile whose `env` is merged into the resume (profile wins over captured). The merged env rides into the relaunch via `AGMUX_INLINE_PROFILE` (already forwarded). Separately, the wrapper's outside-tmux re-exec forwards its full ambient env across the tmux-window boundary instead of a 6-key allowlist.

**Tech Stack:** TypeScript, Bun (test runner + sqlite), tmux. Monorepo packages: `protocol`, `adapters`, `store`, `wrapper`, `cli`.

## Global Constraints

- **Secrets guard (hard):** env capture iterates **only** over an adapter's declared `relaunchEnvKeys`; it never enumerates the environment. No wildcard/prefix capture anywhere in the capture path. (The wrapper re-exec is exempt — it propagates live process env to a child, transient window env, not persisted storage.)
- **TDD:** failing test first, watch it fail, minimal implementation, watch it pass, commit.
- **Test runner:** `bun test <path>` from repo root.
- **Typecheck:** `cd packages/<pkg> && bun run typecheck` (runs `tsc --noEmit`).
- **Commit messages:** short, imperative, prefixed with the package (e.g. `adapters:`). No JIRA key (none for this work). No AI authorship/co-author trailer.
- **Profile env values are tilde-expanded** by `loadProfile` (e.g. `~/.claude-chax` → absolute). Do not re-expand.

---

## File Structure

- `packages/adapters/src/core/types.ts` — add `relaunchEnvKeys: string[]` to `Adapter`.
- `packages/adapters/src/core/env-capture.ts` — **new**: `pickEnv(keys, env)` allowlist-only helper.
- `packages/adapters/src/core/conformance.ts` — assert `relaunchEnvKeys` is `string[]`.
- `packages/adapters/src/adapters/claude/caps.ts` — add `CLAUDE_RELAUNCH_ENV_KEYS`.
- `packages/adapters/src/adapters/claude/index.ts` — `relaunchEnvKeys`.
- `packages/adapters/src/adapters/claude/normalize.ts` — set `env_overrides` on `session.registered`.
- `packages/adapters/src/adapters/{codex,pi}/index.ts` — `relaunchEnvKeys: []`.
- `packages/adapters/tests/fixtures/fake-adapter.ts` — `relaunchEnvKeys: []`.
- `packages/protocol/src/events.ts` — `env_overrides?` on `SessionRegisteredPayload`.
- `packages/store/src/project.ts` — INSERT registered `env_overrides` into `env_json`.
- `packages/cli/src/relaunch.ts` — merge profile env into the native-resume.
- `packages/cli/src/profile-env.ts` — **new**: default `loadProfileEnv(name)`.
- `packages/cli/src/dash-actions.ts`, `packages/cli/src/attach.ts` — pass `loadProfileEnv`.
- `packages/wrapper/src/child-env.ts` — **new** `reexecEnv(base)`.
- `packages/wrapper/src/index.ts` — use `reexecEnv(process.env)` for the re-exec window.

---

## Task 1: Adapter `relaunchEnvKeys` declaration + conformance

**Files:**
- Modify: `packages/adapters/src/core/types.ts` (Adapter interface, ~line 120)
- Modify: `packages/adapters/src/core/conformance.ts:54`
- Modify: `packages/adapters/src/adapters/claude/index.ts`
- Modify: `packages/adapters/src/adapters/codex/index.ts`
- Modify: `packages/adapters/src/adapters/pi/index.ts`
- Modify: `packages/adapters/tests/fixtures/fake-adapter.ts`
- Test: `packages/adapters/tests/conformance.test.ts`

**Interfaces:**
- Produces: `Adapter.relaunchEnvKeys: string[]` — the allowlist of env keys this adapter needs restored at relaunch. Consumed by Task 2 (claude) and the capture helper.

- [ ] **Step 1: Update the conformance test to expect the new check**

In `packages/adapters/tests/conformance.test.ts`, change the expected `passed` array in the "full conformance battery" test:

```typescript
test("the fake adapter passes the full conformance battery", () => {
  const passed = assertAdapterConformance(fakeAdapter, harness());
  expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan", "relaunch-env-keys"]);
});
```

Add a new test at the end of the file:

```typescript
test("conformance rejects an adapter whose relaunchEnvKeys is not a string array", () => {
  const broken: Adapter = { ...fakeAdapter, relaunchEnvKeys: ["ok", 5 as any] };
  expect(() => assertAdapterConformance(broken, harness())).toThrow(/relaunchEnvKeys/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/adapters/tests/conformance.test.ts`
Expected: FAIL — `passed` lacks `"relaunch-env-keys"`, and `fakeAdapter`/`broken` have no `relaunchEnvKeys` (TS may also error once the interface field is added; right now it fails on the assertion).

- [ ] **Step 3: Add `relaunchEnvKeys` to the Adapter interface**

In `packages/adapters/src/core/types.ts`, inside `export interface Adapter`, after `adapterVersion: string;`:

```typescript
  // Env keys this adapter needs restored verbatim at relaunch (spec §6.4) — e.g.
  // the config-dir var that determines where the agent finds its sessions. STRICT
  // allowlist: capture reads ONLY these keys, never the whole environment, so a
  // secret can never be captured by accident. Empty = nothing to restore.
  relaunchEnvKeys: string[];
```

- [ ] **Step 4: Add the conformance check**

In `packages/adapters/src/core/conformance.ts`, after the `passed.push("resumePlan");` line (line 54) and before `return passed;`:

```typescript
  if (!Array.isArray(adapter.relaunchEnvKeys) || adapter.relaunchEnvKeys.some((k) => typeof k !== "string")) {
    throw new Error("conformance: relaunchEnvKeys must be a string[]");
  }
  passed.push("relaunch-env-keys");
```

- [ ] **Step 5: Declare keys on every adapter**

`packages/adapters/src/adapters/claude/caps.ts` — add at the end:

```typescript
// Restored verbatim at relaunch so `claude --resume <id>` finds the conversation
// under the right config dir. Allowlist only (spec §6.4 / secrets guard).
export const CLAUDE_RELAUNCH_ENV_KEYS = ["CLAUDE_CONFIG_DIR"] as const;
```

`packages/adapters/src/adapters/claude/index.ts` — extend the caps import and add the field:

```typescript
import { CLAUDE_SOURCES, CLAUDE_CAPABILITIES, CLAUDE_RELAUNCH_ENV_KEYS } from "./caps.ts";
```
Inside the `claudeAdapter` object literal, add (next to `agentKind`):
```typescript
  relaunchEnvKeys: [...CLAUDE_RELAUNCH_ENV_KEYS],
```

`packages/adapters/src/adapters/codex/index.ts` — inside the `codexAdapter` literal add:
```typescript
  relaunchEnvKeys: [],
```

`packages/adapters/src/adapters/pi/index.ts` — inside the `piAdapter` literal add:
```typescript
  relaunchEnvKeys: [],
```

`packages/adapters/tests/fixtures/fake-adapter.ts` — inside the `fakeAdapter` literal, after `adapterVersion: "1",`:
```typescript
  relaunchEnvKeys: [],
```

- [ ] **Step 6: Run conformance + adapter tests to verify they pass**

Run: `bun test packages/adapters/tests/conformance.test.ts packages/adapters/tests/adapters`
Expected: PASS.

- [ ] **Step 7: Typecheck the adapters package**

Run: `cd packages/adapters && bun run typecheck`
Expected: no output (clean). All four `Adapter` implementers now satisfy the required field.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters
git commit -m "adapters: declare relaunchEnvKeys allowlist + conformance check"
```

---

## Task 2: Capture declared env keys at `session.registered` (claude)

**Files:**
- Create: `packages/adapters/src/core/env-capture.ts`
- Modify: `packages/protocol/src/events.ts` (`SessionRegisteredPayload`, ~line where interface is defined)
- Modify: `packages/adapters/src/adapters/claude/normalize.ts` (the `session.registered` case)
- Test: `packages/adapters/tests/env-capture.test.ts` (new), `packages/adapters/tests/claude-normalize.test.ts`

**Interfaces:**
- Consumes: `Adapter.relaunchEnvKeys` (Task 1), `CLAUDE_RELAUNCH_ENV_KEYS` (Task 1).
- Produces: `pickEnv(keys: readonly string[], env?: Record<string,string|undefined>): Record<string,string>`. And `SessionRegisteredPayload.env_overrides?: Record<string,string>`.

- [ ] **Step 1: Write the failing test for the capture helper**

Create `packages/adapters/tests/env-capture.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { pickEnv } from "../src/core/env-capture.ts";

test("captures only declared keys that are present and non-empty", () => {
  const env = { CLAUDE_CONFIG_DIR: "/x", PATH: "/bin", EMPTY: "" };
  expect(pickEnv(["CLAUDE_CONFIG_DIR", "EMPTY"], env)).toEqual({ CLAUDE_CONFIG_DIR: "/x" });
});

test("never captures an undeclared variable (secrets guard)", () => {
  const env = { CLAUDE_CONFIG_DIR: "/x", SECRET_TOKEN: "shhh", AWS_SECRET_ACCESS_KEY: "nope" };
  const out = pickEnv(["CLAUDE_CONFIG_DIR"], env);
  expect(out).toEqual({ CLAUDE_CONFIG_DIR: "/x" });
  expect(out.SECRET_TOKEN).toBeUndefined();
  expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
});

test("empty key list captures nothing; missing env is safe", () => {
  expect(pickEnv([], { CLAUDE_CONFIG_DIR: "/x" })).toEqual({});
  expect(pickEnv(["CLAUDE_CONFIG_DIR"], undefined)).toEqual({});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/adapters/tests/env-capture.test.ts`
Expected: FAIL — `pickEnv` does not exist.

- [ ] **Step 3: Implement the capture helper**

Create `packages/adapters/src/core/env-capture.ts`:

```typescript
// Allowlist-only env capture. Iterates the DECLARED key list and pulls present,
// non-empty values from the env. It never enumerates the environment, so an
// undeclared variable (a secret/token) is structurally impossible to capture.
export function pickEnv(
  keys: readonly string[],
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/adapters/tests/env-capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `env_overrides` to the protocol payload**

In `packages/protocol/src/events.ts`, in `interface SessionRegisteredPayload`, add after `parent: NativeIdentity | null;`:

```typescript
  // Config-affecting env captured from the agent's hook env at registration —
  // ONLY the adapter's declared relaunchEnvKeys (allowlist). Restored at relaunch
  // so a native session resumes under the same config dir. Optional/absent on
  // older emitters → treated as {}.
  env_overrides?: Record<string, string>;
```

- [ ] **Step 6: Write the failing test for claude normalize capturing env**

In `packages/adapters/tests/claude-normalize.test.ts`, append (the file already imports `normalizeClaude`):

```typescript
test("session.registered captures CLAUDE_CONFIG_DIR into env_overrides", () => {
  const out = normalizeClaude({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "n-1", cwd: "/work" },
    target: { agentKind: "claude", profile: null },
    env: { CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax", SECRET_TOKEN: "shhh" },
  } as any);
  expect(out.events).toHaveLength(1);
  const p = out.events[0]!.payload as any;
  expect(p.env_overrides).toEqual({ CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax" });
  expect(p.env_overrides.SECRET_TOKEN).toBeUndefined();
});

test("session.registered with no config dir yields empty env_overrides", () => {
  const out = normalizeClaude({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "n-2", cwd: "/work" },
    target: { agentKind: "claude", profile: null },
    env: {},
  } as any);
  expect((out.events[0]!.payload as any).env_overrides).toEqual({});
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test packages/adapters/tests/claude-normalize.test.ts`
Expected: FAIL — payload has no `env_overrides`.

- [ ] **Step 8: Capture env in claude normalize**

In `packages/adapters/src/adapters/claude/normalize.ts`, add imports at the top:

```typescript
import { pickEnv } from "../../core/env-capture.ts";
import { CLAUDE_RELAUNCH_ENV_KEYS } from "./caps.ts";
```

In the `case "session.registered":` block, inside the returned payload object, add `env_overrides` (alongside `native_session_id`, etc.):

```typescript
          env_overrides: pickEnv(CLAUDE_RELAUNCH_ENV_KEYS, env),
```

(Note: `env` is already bound in that case as `const env = input.env ?? {};`.)

- [ ] **Step 9: Run normalize + capture tests to verify they pass**

Run: `bun test packages/adapters/tests/claude-normalize.test.ts packages/adapters/tests/env-capture.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck adapters + protocol**

Run: `cd packages/protocol && bun run typecheck && cd ../adapters && bun run typecheck`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add packages/adapters packages/protocol
git commit -m "adapters: capture declared relaunch env at session.registered"
```

---

## Task 3: Persist registered `env_overrides` into the store

**Files:**
- Modify: `packages/store/src/project.ts` (`applyRegistered`, the INSERT branch ~lines 176-197)
- Test: `packages/store/tests/registered.test.ts`

**Interfaces:**
- Consumes: `SessionRegisteredPayload.env_overrides` (Task 2).
- Produces: native session rows whose `env_json` reflects captured env (read back by `queries.ts` as `session.env_overrides`).

- [ ] **Step 1: Write the failing test**

In `packages/store/tests/registered.test.ts`, add:

```typescript
test("mint: registered env_overrides is persisted into env_json", () => {
  const db = freshDb();
  applyEventToProjection(db, regEv("s-env", { native_session_id: "n-e", pid: 1, env_overrides: { CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax" } }));
  const r = row(db, "s-env");
  expect(JSON.parse(r.env_json)).toEqual({ CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax" });
});

test("mint: registered with no env_overrides stores an empty object", () => {
  const db = freshDb();
  applyEventToProjection(db, regEv("s-env0", { native_session_id: "n-e0", pid: 1 }));
  expect(JSON.parse(row(db, "s-env0").env_json)).toEqual({});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/store/tests/registered.test.ts`
Expected: FAIL — `env_json` is `'{}'` (hardcoded) for the env_overrides case.

- [ ] **Step 3: Write registered env_overrides into the INSERT**

In `packages/store/src/project.ts`, `applyRegistered`, the `if (!existing)` INSERT: change the hardcoded `'{}'` for `env_json` to a bound parameter.

Change the VALUES line `?, '[]', '{}', ?, ?,` (the `command, args_json, env_json, cwd, pid` row) to:

```sql
        ?, '[]', ?, ?, ?,
```

And change the `.run(...)` argument line:

```typescript
      ev.session_id, p.agent_kind, p.profile ?? null, p.native_session_id,
      p.command ?? p.agent_kind, JSON.stringify(p.env_overrides ?? {}), p.cwd ?? "", p.pid ?? null,
      p.tmux_session ?? null, p.tmux_window ?? null, p.tmux_pane ?? null, ev.host,
      ev.ts,
```

(Only the INSERT/mint branch changes. The reopen and live branches are intentionally left untouched — env is captured at first registration; refreshing it on re-registration is unnecessary for resume. YAGNI.)

- [ ] **Step 4: Run store tests to verify they pass**

Run: `bun test packages/store/tests/registered.test.ts`
Expected: PASS. Confirm pre-existing tests in the file still pass.

- [ ] **Step 5: Typecheck store**

Run: `cd packages/store && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/store
git commit -m "store: persist registered env_overrides into env_json"
```

---

## Task 4: Merge profile env into the native resume

**Files:**
- Modify: `packages/cli/src/relaunch.ts`
- Test: `packages/cli/tests/relaunch.test.ts`

**Interfaces:**
- Produces: `RelaunchOpts.loadProfileEnv?: (name: string) => Record<string,string> | undefined`. When set and `session.profile` is non-null, that profile's env is merged over captured `env_overrides` (profile wins) and flows into the resume plan's env.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/tests/relaunch.test.ts`, add:

```typescript
test("native resume merges profile env over captured env (profile wins)", () => {
  const spec = buildRelaunchSpec(
    row({ profile: "work", native_session_id: "n", env_overrides: { CLAUDE_CONFIG_DIR: "/captured", X: "1" } }),
    {
      hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {}, turnCount: 3,
      loadProfileEnv: (name) => (name === "work" ? { CLAUDE_CONFIG_DIR: "/profile" } : undefined),
    },
  );
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.args).toEqual(["resume", "n"]);     // still a native resume
  expect(inline.env.CLAUDE_CONFIG_DIR).toBe("/profile"); // profile wins over captured
  expect(inline.env.X).toBe("1");                   // captured-only key preserved
});

test("native resume carries captured env when there is no profile loader", () => {
  const spec = buildRelaunchSpec(
    row({ profile: null, native_session_id: "n", env_overrides: { CLAUDE_CONFIG_DIR: "/captured" } }),
    { hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {}, turnCount: 3 },
  );
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.env.CLAUDE_CONFIG_DIR).toBe("/captured");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/cli/tests/relaunch.test.ts`
Expected: FAIL — `loadProfileEnv` is not a known option and profile env is not merged (`inline.env.CLAUDE_CONFIG_DIR` would be `/captured`, not `/profile`).

- [ ] **Step 3: Add the option and merge logic**

In `packages/cli/src/relaunch.ts`, add to `RelaunchOpts`:

```typescript
  // Resolve a named profile's env (tilde-expanded). Injected by the CLI so
  // buildRelaunchSpec stays pure/testable. When set and session.profile is
  // non-null, the profile's env is merged OVER captured env_overrides.
  loadProfileEnv?: (name: string) => Record<string, string> | undefined;
```

Replace the `extraEnv` initialization and the `resumePlan` env argument. Change:

```typescript
  let extraEnv: Record<string, string> = session.env_overrides ?? {};
  let resumed = false;
```
to:
```typescript
  // Precedence: captured env_overrides < profile env (B wins). The merged env
  // becomes the resume plan's env and the inline profile's env.
  const capturedEnv = session.env_overrides ?? {};
  const profileEnv = session.profile && opts.loadProfileEnv ? (opts.loadProfileEnv(session.profile) ?? {}) : {};
  const sessionEnv: Record<string, string> = { ...capturedEnv, ...profileEnv };
  let extraEnv: Record<string, string> = sessionEnv;
  let resumed = false;
```

And in the `adapter.resumePlan({ ... })` call, change `env: session.env_overrides ?? {},` to:

```typescript
      env: sessionEnv, nativeSessionId: session.native_session_id,
```
(Replacing the existing `env: session.env_overrides ?? {}, nativeSessionId: session.native_session_id,` line.)

- [ ] **Step 4: Run relaunch tests to verify they pass**

Run: `bun test packages/cli/tests/relaunch.test.ts`
Expected: PASS (new + all pre-existing).

- [ ] **Step 5: Typecheck cli**

Run: `cd packages/cli && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/relaunch.ts packages/cli/tests/relaunch.test.ts
git commit -m "cli: merge profile env into native resume (profile wins)"
```

---

## Task 5: Default profile-env loader + wire into resume/attach

**Files:**
- Create: `packages/cli/src/profile-env.ts`
- Modify: `packages/cli/src/dash-actions.ts` (the `resume` action's `buildRelaunchSpec` call)
- Modify: `packages/cli/src/attach.ts` (the `buildRelaunchSpec` call)
- Test: `packages/cli/tests/profile-env.test.ts` (new)

**Interfaces:**
- Consumes: `RelaunchOpts.loadProfileEnv` (Task 4).
- Produces: `loadProfileEnv(name: string): Record<string,string> | undefined` reading `~/.config/agmux/config.toml`; returns `undefined` if config/profile is missing.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/tests/profile-env.test.ts`:

```typescript
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadProfileEnvFrom } from "../src/profile-env.ts";

function tmpConfig(toml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-pe-"));
  const p = path.join(dir, "config.toml");
  fs.writeFileSync(p, toml);
  return p;
}

test("returns the profile's env (tilde-expanded by loadProfile)", () => {
  const cfg = tmpConfig(`[profiles.work]\nagent_kind = "claude"\ncommand = "claude"\nargs = []\nenv = { CLAUDE_CONFIG_DIR = "~/.claude-chax" }\n`);
  const env = loadProfileEnvFrom("work", cfg)!;
  expect(env.CLAUDE_CONFIG_DIR).toBe(os.homedir() + "/.claude-chax");
});

test("missing profile or config → undefined (never throws)", () => {
  const cfg = tmpConfig(`[profiles.work]\nagent_kind = "claude"\ncommand = "claude"\nargs = []\n`);
  expect(loadProfileEnvFrom("nope", cfg)).toBeUndefined();
  expect(loadProfileEnvFrom("work", "/does/not/exist.toml")).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/tests/profile-env.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the loader**

Create `packages/cli/src/profile-env.ts`:

```typescript
import * as os from "node:os";
import * as path from "node:path";
import { AGMUX_CONFIG_SUBPATH } from "@agmux/protocol";
import { loadProfile } from "@agmux/wrapper";

// Resolve a named profile's env from a specific config file. Returns undefined
// (never throws) when the config or profile is absent — a native session may
// carry an AGMUX_PROFILE that no longer exists.
export function loadProfileEnvFrom(name: string, configPath: string): Record<string, string> | undefined {
  try {
    return loadProfile(name, configPath).env;
  } catch {
    return undefined;
  }
}

// The default loader against the user's real config (~/.config/agmux/config.toml).
export function loadProfileEnv(name: string): Record<string, string> | undefined {
  return loadProfileEnvFrom(name, path.join(os.homedir(), AGMUX_CONFIG_SUBPATH));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/cli/tests/profile-env.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the loader into the dash resume action**

In `packages/cli/src/dash-actions.ts`, add the import near the other local imports:

```typescript
import { loadProfileEnv } from "./profile-env.ts";
```

In the `resume` action, add `loadProfileEnv` to the `buildRelaunchSpec` options object:

```typescript
      const spec = buildRelaunchSpec(session, {
        hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
        turnCount: usage?.turn_count ?? 0, loadProfileEnv,
      });
```

- [ ] **Step 6: Wire the loader into `attach`**

In `packages/cli/src/attach.ts`, add the import:

```typescript
import { loadProfileEnv } from "./profile-env.ts";
```

Add `loadProfileEnv` to the `buildRelaunchSpec` options in `attachCmd`:

```typescript
  const spec = buildRelaunchSpec(session, {
    hubUrl: opts.hubUrl,
    wrapBin: opts.wrapBin,
    registry: opts.registry ?? createDefaultRegistry(),
    baseEnv: process.env,
    turnCount: usage?.turn_count ?? 0,
    loadProfileEnv,
  });
```

- [ ] **Step 7: Typecheck + run the CLI suite**

Run: `cd packages/cli && bun run typecheck && cd ../.. && bun test packages/cli`
Expected: clean typecheck; all CLI tests pass (incl. the untouched `dash-actions.test.ts` allowlist test).

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/profile-env.ts packages/cli/tests/profile-env.test.ts packages/cli/src/dash-actions.ts packages/cli/src/attach.ts
git commit -m "cli: wire default profile-env loader into resume and attach"
```

---

## Task 6: Wrapper re-exec forwards full env

**Files:**
- Modify: `packages/wrapper/src/child-env.ts` (add `reexecEnv`)
- Modify: `packages/wrapper/src/index.ts` (use `reexecEnv`; drop now-unused imports)
- Test: `packages/wrapper/tests/child-env.test.ts`

**Interfaces:**
- Produces: `reexecEnv(base: Record<string,string|undefined>): Record<string,string>` — full copy of the base env minus `undefined` values, for forwarding across the tmux-window boundary on the outside-tmux re-exec.

- [ ] **Step 1: Write the failing test**

In `packages/wrapper/tests/child-env.test.ts`, add:

```typescript
import { reexecEnv } from "../src/child-env.ts";

test("reexecEnv forwards the full env (incl. non-agmux vars) and drops undefined", () => {
  const out = reexecEnv({
    CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax",
    PATH: "/bin",
    AGMUX_INLINE_PROFILE: "{}",
    GONE: undefined,
  });
  expect(out.CLAUDE_CONFIG_DIR).toBe("/Users/u/.claude-chax");
  expect(out.PATH).toBe("/bin");
  expect(out.AGMUX_INLINE_PROFILE).toBe("{}");
  expect("GONE" in out).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/wrapper/tests/child-env.test.ts`
Expected: FAIL — `reexecEnv` does not exist.

- [ ] **Step 3: Implement `reexecEnv`**

In `packages/wrapper/src/child-env.ts`, add at the end:

```typescript
// Full env to forward to the inner wrapper when the outer wrapper re-execs into a
// new tmux window (outside-tmux launch). A new window inherits only the tmux SERVER
// env and runs the command with no login shell, so anything the user set for this
// launch (PATH tweaks, CLAUDE_CONFIG_DIR, …) is lost unless we carry it. The outer
// wrapper IS the launch and holds the exact ambient env, so full forwarding is the
// correct process-continuation behavior. This is transient tmux window env (process
// propagation), not persisted storage — the allowlist-only capture rule (which
// guards what we STORE) does not apply here.
export function reexecEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/wrapper/tests/child-env.test.ts`
Expected: PASS.

- [ ] **Step 5: Use `reexecEnv` in the re-exec path**

In `packages/wrapper/src/index.ts`, add `reexecEnv` to the child-env import:

```typescript
import { buildChildEnv, reexecEnv } from "./child-env.ts";
```

Replace the allowlist block (the `const innerEnv: Record<string, string> = {};` loop over the 6 keys, ~lines 71-82) with:

```typescript
    // Forward the full ambient env across the tmux-window boundary (see reexecEnv).
    const innerEnv = reexecEnv(process.env);
```

- [ ] **Step 6: Drop now-unused imports**

In `packages/wrapper/src/index.ts`, the protocol import block no longer uses `AGMUX_HUB_URL_ENV` or `AGMUX_PROFILE_ENV` (they were only in the deleted loop). Remove those two names from the import, leaving:

```typescript
import {
  AGMUX_SESSION_ID_ENV,
  AGMUX_TMUX_SESSION_ENV,
  AGMUX_TMUX_SESSION_DEFAULT,
} from "@agmux/protocol";
```

- [ ] **Step 7: Typecheck wrapper + run its tests**

Run: `cd packages/wrapper && bun run typecheck && cd ../.. && bun test packages/wrapper`
Expected: clean typecheck (no unused-import error); all wrapper tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/wrapper
git commit -m "wrapper: forward full env on outside-tmux re-exec"
```

---

## Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `bun test`
Expected: all packages green.

- [ ] **Step 2: Typecheck the whole workspace**

Run: `bun run typecheck`
Expected: clean across all packages.

- [ ] **Step 3: Manual smoke (optional, requires a real native session)**

With `AGMUX_PROFILE=claude-work` added to the `ccc` alias, start a native Claude session, run a turn, quit it, then resume it from `agmux dash`. Expected: the relaunched window runs `claude --resume <id>` under `CLAUDE_CONFIG_DIR=~/.claude-chax` and the conversation loads. (Sessions registered *before* this change won't have captured env — test with a freshly-started session.)

---

## Self-Review

**Spec coverage:**
- Mechanism A (adapter-declared keys) → Tasks 1 (declare + conformance) + 2 (capture).
- Mechanism A storage → Task 3.
- Mechanism B (`AGMUX_PROFILE` profile env on native-resume) → Tasks 4 (merge) + 5 (loader/wiring). Capture side needs no code (hook already records `profile`).
- Precedence captured < profile → Task 4 test asserts profile wins.
- Secrets guard → `pickEnv` (Task 2) + dedicated test; conformance enforces `relaunchEnvKeys` is the only capture surface.
- Dash path keeps allowlist → unchanged (already reverted); Task 5 only adds `loadProfileEnv`; `dash-actions.test.ts` allowlist test stays green (Task 5 Step 7).
- Wrapper re-exec full env → Task 6.
- Out of scope (profile matcher) → not implemented. Codex/pi `relaunchEnvKeys: []` per spec (CODEX_HOME a trivial future extension).

**Placeholder scan:** none — every code step shows the exact code; every run step shows the command + expected result.

**Type consistency:** `relaunchEnvKeys: string[]` (Task 1) consumed in Tasks 1/2. `pickEnv(keys, env)` (Task 2) used in claude normalize. `SessionRegisteredPayload.env_overrides?` (Task 2) read in store (Task 3) as `p.env_overrides`. `RelaunchOpts.loadProfileEnv` (Task 4) provided by `loadProfileEnv` (Task 5). `reexecEnv` (Task 6) name consistent between `child-env.ts` and `index.ts`.
