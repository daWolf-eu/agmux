# agmux Self-Documentation Skill Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two agmux-authored skills (`agmux-overview`, `agmux-troubleshooting`) that teach an agent how to use and troubleshoot agmux, delivered into Claude, Codex, and Pi sessions as part of `agmux adapter install`.

**Architecture:** A single skill **catalog** lives in `@agmux/adapters` (`src/skills/`) and is the one source of truth for skill content. Each adapter's existing `install()` materializes the catalog into that agent's auto-discovered skill location (Claude: inside the existing plugin's `skills/`; Codex: `$HOME/.agents/skills/agmux/`; Pi: `<configDir>/skills/agmux/`). A `--no-skills` flag opts out. A static `SKILL_SURFACES` matrix records each kind's skill surface. No new package, no launcher changes, no runtime `--skill` injection (that is deferred scope B).

**Tech Stack:** TypeScript on Bun. Bun test (`bun test`). Skill bodies are embedded TypeScript template literals (compile-safe under `bun build --compile`, consistent with the existing `plugin-files.ts`/`extension-files.ts` payloads). Spec: [`../superpowers/specs/2026-06-19-agmux-skill-delivery-design.md`](../superpowers/specs/2026-06-19-agmux-skill-delivery-design.md).

---

## File Structure

**New (in `@agmux/adapters`):**
- `packages/adapters/src/skills/types.ts` — `SkillDef` interface.
- `packages/adapters/src/skills/agmux-overview.ts` — the `agmux-overview` skill def + body.
- `packages/adapters/src/skills/agmux-troubleshooting.ts` — the `agmux-troubleshooting` skill def + body.
- `packages/adapters/src/skills/catalog.ts` — `SKILLS: SkillDef[]` (the registry).
- `packages/adapters/src/skills/compose.ts` — `skillFileContent(def)` + `writeSkills(baseDir)`.
- `packages/adapters/src/skills/surface.ts` — `SkillSurface` + `SKILL_SURFACES` matrix.
- `packages/adapters/src/skills/index.ts` — barrel.
- `packages/adapters/tests/skills.test.ts` — catalog + compose + surface tests.
- `packages/cli/tests/adapter-cmd.test.ts` — `--no-skills` integration test.

**Modified:**
- `packages/adapters/src/core/types.ts` — add `skills?: boolean` to `InstallContext`.
- `packages/adapters/src/index.ts` — re-export the skills barrel.
- `packages/adapters/src/adapters/claude/install.ts` — materialize skills into the plugin.
- `packages/adapters/src/adapters/codex/install.ts` — materialize skills to `$HOME/.agents/skills`; remove file artifacts on uninstall.
- `packages/adapters/src/adapters/pi/install.ts` — materialize skills into `<configDir>/skills/agmux`; recursive uninstall.
- `packages/cli/src/adapter-cmd.ts` — parse/thread `--no-skills`.
- `packages/adapters/tests/adapters/{claude,codex,pi}.test.ts` — skill-delivery tests (codex also gets a temp-`HOME` guard).

**Docs:**
- `docs/backlog/05-skill-bundling-runner.md` — deferred (B) handoff doc.

---

## Task 1: Skill catalog + compose + surface matrix (single source of truth)

**Files:**
- Create: `packages/adapters/src/skills/types.ts`
- Create: `packages/adapters/src/skills/agmux-overview.ts`
- Create: `packages/adapters/src/skills/agmux-troubleshooting.ts`
- Create: `packages/adapters/src/skills/catalog.ts`
- Create: `packages/adapters/src/skills/compose.ts`
- Create: `packages/adapters/src/skills/surface.ts`
- Create: `packages/adapters/src/skills/index.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/tests/skills.test.ts`

- [ ] **Step 1: Verify the CLI verbs and env names referenced by the skill bodies actually exist**

The skill bodies reference these commands/vars. Confirm each before authoring so we ship accurate guidance:

Run: `grep -rEn '"(ls|watch|dash|inspect|adapter|run|kill|attach)"' packages/cli/bin packages/cli/src | head -40`
Run: `grep -rn "AGMUX_HUB_URL\|\.agmux/cursors\|AGMUX_SESSION_ID" packages/cli/src packages/adapters/src | head`

Expected: `ls`, `watch`, `dash`, `inspect`, `adapter` are dispatched verbs; `AGMUX_HUB_URL`, `~/.agmux/cursors`, `AGMUX_SESSION_ID` appear. If any referenced command/var is named differently, adjust the body text in Steps 5–6 to match reality (do NOT invent commands).

- [ ] **Step 2: Write the failing catalog test**

Create `packages/adapters/tests/skills.test.ts`:

```ts
import { test, expect } from "bun:test";
import { AGENT_KINDS } from "@agmux/protocol";
import { SKILLS } from "../src/skills/catalog.ts";
import { skillFileContent } from "../src/skills/compose.ts";
import { SKILL_SURFACES } from "../src/skills/surface.ts";

test("catalog ships the two agmux self-doc skills with unique names", () => {
  const names = SKILLS.map((s) => s.name);
  expect(names).toContain("agmux-overview");
  expect(names).toContain("agmux-troubleshooting");
  expect(new Set(names).size).toBe(names.length);
});

test("every skill has non-empty fields and a budget-safe description", () => {
  for (const s of SKILLS) {
    expect(s.name.length).toBeGreaterThan(0);
    expect(s.description.length).toBeGreaterThan(0);
    expect(s.description.length).toBeLessThanOrEqual(1536); // Claude skill-listing cap
    expect(s.body.length).toBeGreaterThan(0);
    expect(s.body.includes("`")).toBe(false); // bodies avoid backticks (template-literal authoring)
  }
});

test("compose emits YAML frontmatter then the body", () => {
  const def = SKILLS[0]!;
  const md = skillFileContent(def);
  expect(md.startsWith("---\n")).toBe(true);
  expect(md).toContain(`name: ${def.name}\n`);
  expect(md).toContain(`description: ${JSON.stringify(def.description)}\n`);
  expect(md).toContain("\n---\n\n");
  expect(md.trimEnd().endsWith(def.body.trimEnd())).toBe(true);
});

test("every agent_kind has a skill-surface descriptor; all three deliver at install time", () => {
  for (const k of AGENT_KINDS) {
    expect(SKILL_SURFACES[k]).toBeDefined();
    expect(typeof SKILL_SURFACES[k]!.installTime).toBe("boolean");
  }
  expect(SKILL_SURFACES.claude).toMatchObject({ installTime: true, isolation: "config-dir" });
  expect(SKILL_SURFACES.codex).toMatchObject({ installTime: true, isolation: "host-global" });
  expect(SKILL_SURFACES.pi).toMatchObject({ installTime: true, isolation: "config-dir" });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/adapters && bun test tests/skills.test.ts`
Expected: FAIL — modules `../src/skills/catalog.ts` etc. do not resolve.

- [ ] **Step 4: Write the `SkillDef` type**

Create `packages/adapters/src/skills/types.ts`:

```ts
// One agmux-authored skill, agent-agnostic. compose() turns this into a SKILL.md.
// Authored as embedded code (catalog + body files) so it works identically from
// source and from a `bun build --compile` binary (cf. plugin-files.ts).
export interface SkillDef {
  name: string;        // dir name + frontmatter `name`; also the flat label on Codex/Pi
  description: string; // frontmatter `description`; drives triggering; keep <=1536 chars
  body: string;        // SKILL.md markdown WITHOUT frontmatter (compose adds it)
}
```

- [ ] **Step 5: Write the `agmux-overview` skill**

Create `packages/adapters/src/skills/agmux-overview.ts`. The body uses 4-space-indented code blocks (no backticks) so it embeds in a template literal without escaping:

```ts
import type { SkillDef } from "./types.ts";

const body = `# Using agmux

agmux records every AI agent session (Claude, Codex, Pi, and others) into one
local append-only event log and exposes it through a hub daemon. You are
running inside an agmux-tracked session right now.

## Your session id

Your canonical agmux session id is in the AGMUX_SESSION_ID environment
variable. Everything this session does is joined to it. To see your own
record:

    agmux inspect "$AGMUX_SESSION_ID"

## Seeing sessions

    agmux ls            # list recorded sessions, most recent first
    agmux watch         # live activity view (TUI)
    agmux dash          # usage / metrics dashboard (TUI)
    agmux inspect <id>  # full detail for one session

All of the above are read-only and safe to run at any time.

## Concepts

- agent_kind: the underlying agent (claude, codex, pi).
- profile: a named launch preset (for example claude-work); many profiles map
  to one agent_kind.
- The event log is the source of truth; the live views read fast projection
  tables derived from it.
`;

export const AGMUX_OVERVIEW: SkillDef = {
  name: "agmux-overview",
  description:
    "Explains what agmux is and how to inspect your own and other recorded agent sessions. " +
    "Use when the user asks what agmux is, how this session is tracked, what their session id is, " +
    "or how to list, inspect, or watch agmux sessions.",
  body,
};
```

- [ ] **Step 6: Write the `agmux-troubleshooting` skill**

Create `packages/adapters/src/skills/agmux-troubleshooting.ts`:

```ts
import type { SkillDef } from "./types.ts";

const body = `# Troubleshooting agmux

Use this when agmux seems to be missing events, the hub looks down, or an
adapter looks misconfigured.

## Is this session being recorded?

    agmux inspect "$AGMUX_SESSION_ID"

If that errors or shows nothing, events from this session are not reaching the
hub.

## Check the adapter install

agmux delivers its telemetry hooks through a per-agent adapter. Check it:

    agmux adapter status <profile>        # or: --kind claude|codex|pi

- "not installed": run agmux adapter install <profile> (or --kind ...).
- "[drift]": the installed payload is stale; reinstall to refresh it.

## Is the hub reachable?

The hub is the local daemon that ingests events. Its URL is in the
AGMUX_HUB_URL environment variable (a localhost address). If events are not
landing, confirm the hub process is running and that URL is reachable.

## Where agmux keeps state

- ~/.agmux/ is the state directory.
- ~/.agmux/cursors/ holds per-session transcript cursors.
- When the hub is unreachable, events are buffered in an on-disk queue and
  flushed on the next successful post.

## Common causes

- Hooks not firing: the agent's hook-trust prompt may not have been accepted
  for this config dir; the first session after install can be ungated.
- AGMUX_SESSION_ID unset: the session was launched outside agmux. For
  adapter-backed kinds, native self-registration still applies.
`;

export const AGMUX_TROUBLESHOOTING: SkillDef = {
  name: "agmux-troubleshooting",
  description:
    "Diagnoses agmux when events look missing, the hub seems down, or an adapter is misconfigured. " +
    "Use when agmux is not recording, sessions do not appear in agmux ls or agmux inspect, " +
    "adapter status shows drift, or AGMUX_SESSION_ID is unset.",
  body,
};
```

- [ ] **Step 7: Write the catalog**

Create `packages/adapters/src/skills/catalog.ts`:

```ts
import type { SkillDef } from "./types.ts";
import { AGMUX_OVERVIEW } from "./agmux-overview.ts";
import { AGMUX_TROUBLESHOOTING } from "./agmux-troubleshooting.ts";

// THE single source of truth for agmux-shipped skills. Every adapter's install()
// materializes this list into the agent's auto-discovered skill location.
export const SKILLS: SkillDef[] = [AGMUX_OVERVIEW, AGMUX_TROUBLESHOOTING];
```

- [ ] **Step 8: Write compose (frontmatter + filesystem materialization)**

Create `packages/adapters/src/skills/compose.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillDef } from "./types.ts";
import { SKILLS } from "./catalog.ts";

// Compose a SKILL.md (YAML frontmatter + body). The description is JSON.stringify'd
// so colons/quotes can never break the YAML; JSON strings are valid YAML scalars.
export function skillFileContent(def: SkillDef): string {
  return `---\nname: ${def.name}\ndescription: ${JSON.stringify(def.description)}\n---\n\n${def.body.trimEnd()}\n`;
}

// Materialize every catalog skill under baseDir as <baseDir>/<name>/SKILL.md.
// Returns baseDir so the caller can record it as a single uninstall artifact.
export function writeSkills(baseDir: string, skills: SkillDef[] = SKILLS): string {
  for (const def of skills) {
    const target = path.join(baseDir, def.name, "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, skillFileContent(def), { mode: 0o644 });
  }
  return baseDir;
}
```

- [ ] **Step 9: Write the capability matrix**

Create `packages/adapters/src/skills/surface.ts`:

```ts
import type { AgentKind } from "@agmux/protocol";

// Per-kind install-time skill surface — one source feeding both the docs matrix
// and the conformance test. mechanism "runtime-flag"/"none" are reserved for
// kinds without an install-time dir (see spec scope B); none used this branch.
export interface SkillSurface {
  installTime: boolean;
  mechanism: "plugin-skills-dir" | "personal-skills-dir" | "skills-dir" | "runtime-flag" | "none";
  isolation: "config-dir" | "host-global" | "n/a";
  label: string; // how the skill is labeled in the agent's skill list
  note?: string;
}

export const SKILL_SURFACES: Record<AgentKind, SkillSurface> = {
  claude: { installTime: true, mechanism: "plugin-skills-dir", isolation: "config-dir", label: "agmux:<name>" },
  codex: {
    installTime: true, mechanism: "personal-skills-dir", isolation: "host-global", label: "<name>",
    note: "discovered from $HOME/.agents/skills, not CODEX_HOME-scoped",
  },
  pi: { installTime: true, mechanism: "skills-dir", isolation: "config-dir", label: "<name>" },
};
```

- [ ] **Step 10: Write the skills barrel**

Create `packages/adapters/src/skills/index.ts`:

```ts
export * from "./types.ts";
export * from "./catalog.ts";
export * from "./compose.ts";
export * from "./surface.ts";
```

- [ ] **Step 11: Re-export skills from the package barrel**

In `packages/adapters/src/index.ts`, add the skills export after the core re-export (line 1):

```ts
export * from "./core/index.ts";
export * from "./skills/index.ts";
```

(Leave the rest of the file unchanged.)

- [ ] **Step 12: Run the test to verify it passes**

Run: `cd packages/adapters && bun test tests/skills.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 13: Commit**

```bash
git add packages/adapters/src/skills packages/adapters/src/index.ts packages/adapters/tests/skills.test.ts
git commit -m "skills: add agmux self-doc skill catalog + capability matrix"
```

---

## Task 2: Add `skills` opt-out to InstallContext

**Files:**
- Modify: `packages/adapters/src/core/types.ts:43-45`

- [ ] **Step 1: Add the field**

In `packages/adapters/src/core/types.ts`, inside `InstallContext`, after the `configDirOverride` field (line 43-44), add:

```ts
  configDirOverride?: string | null; // explicit --config-dir from the CLI; the adapter
                                     // interprets it (highest-priority config-dir source)
  // Deliver agmux's self-documentation skills alongside the telemetry payload
  // (default: undefined/true). The CLI `--no-skills` flag sets this false.
  skills?: boolean;
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/adapters && bunx tsc --noEmit`
Expected: PASS (no type errors; the field is optional so no caller breaks).

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/src/core/types.ts
git commit -m "adapters: add optional skills flag to InstallContext"
```

---

## Task 3: Claude skill delivery (config-dir isolated, inside the plugin)

**Files:**
- Modify: `packages/adapters/src/adapters/claude/install.ts`
- Test: `packages/adapters/tests/adapters/claude.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to claude.test.ts)**

At the end of `packages/adapters/tests/adapters/claude.test.ts`, add:

```ts
import { SKILLS } from "../../src/skills/index.ts";

test("install delivers self-doc skills inside the plugin; --no-skills omits them", () => {
  const cfg = tmpCfg();
  const rec = claudeInstall({ ...ictx(cfg), skills: true } as any);
  const skillsRoot = path.join(skillsPluginDir(cfg), "skills");
  for (const s of SKILLS) {
    expect(fs.existsSync(path.join(skillsRoot, s.name, "SKILL.md"))).toBe(true);
  }
  // Removed with the plugin dir on uninstall.
  claudeUninstall(ictx(cfg) as any, rec);
  expect(fs.existsSync(skillsRoot)).toBe(false);

  const cfg2 = tmpCfg();
  claudeInstall({ ...ictx(cfg2), skills: false } as any);
  expect(fs.existsSync(path.join(skillsPluginDir(cfg2), "skills"))).toBe(false);
  // The telemetry plugin is still installed.
  expect(fs.existsSync(path.join(skillsPluginDir(cfg2), ".claude-plugin", "plugin.json"))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/adapters && bun test tests/adapters/claude.test.ts -t "delivers self-doc skills"`
Expected: FAIL — skills dir does not exist (install does not write skills yet).

- [ ] **Step 3: Implement skill materialization in claudeInstall**

In `packages/adapters/src/adapters/claude/install.ts`:

Add the import after the existing `plugin-files` import (line 6):

```ts
import { PLUGIN_FILES, PLUGIN_VERSION } from "./plugin-files.ts";
import { writeSkills } from "../../skills/compose.ts";
```

In `claudeInstall`, after the `for (const f of PLUGIN_FILES) { ... }` loop and before `return {`:

```ts
  }
  // Deliver agmux self-doc skills inside the plugin's skills/ dir (label agmux:<name>).
  // They live under `dest`, so the existing uninstall (rm -rf dest) removes them too.
  if (ctx.skills !== false) writeSkills(path.join(dest, "skills"));
  return {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/adapters && bun test tests/adapters/claude.test.ts`
Expected: PASS (all claude tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/claude/install.ts packages/adapters/tests/adapters/claude.test.ts
git commit -m "adapters: deliver agmux self-doc skills in the claude plugin"
```

---

## Task 4: Codex skill delivery (host-global `$HOME/.agents/skills`)

**Files:**
- Modify: `packages/adapters/src/adapters/codex/install.ts`
- Test: `packages/adapters/tests/adapters/codex.test.ts` (modify helpers + append)

> **Codex install target:** `$HOME/.agents/skills/agmux/` — the USER-scope skill dir. Codex has no `CODEX_HOME`-scoped skill location (its other roots are repo/launch-context `$CWD`/`$REPO_ROOT/.agents/skills`, admin `/etc/codex/skills`, and bundled), so USER scope is the correct target for a per-user installer.
>
> **Tests** drive this through the standard `process.env.HOME` seam: `codexSkillsDir()` reads `process.env.HOME` first, so the new skill tests point it at a temp dir. Existing marketplace/telemetry tests pass `skills: false` (they're not about skills), keeping them unchanged in intent.

- [ ] **Step 1: Guard existing codex tests from writing to the real home**

In `packages/adapters/tests/adapters/codex.test.ts`, modify the `ictx` helper (around line 215-220) to default skills off (these tests exercise the marketplace path, not skills):

```ts
const ictx = (configDir: string | undefined, stateDir: string, profile: string | null = null, override: string | null = null) => ({
  agentKind: "codex" as const, profile,
  profileEnv: (configDir ? { CODEX_HOME: configDir } : {}) as Record<string, string>,
  agmuxEmitPath: "/abs/agmux emit", stateDir, skills: false,
  ...(override ? { configDirOverride: override } : {}),
});
```

And in the conformance test's `makeContext` (around line 329), add `skills: false`:

```ts
      makeContext: () => ({ agentKind: "codex", profile: null, profileEnv: { CODEX_HOME: cfg }, agmuxEmitPath: "/abs/agmux emit", stateDir: state, skills: false }),
```

- [ ] **Step 2: Write the failing skill tests (append to codex.test.ts)**

Add `codexSkillsDir` to the existing install import line (around line 185):

```ts
import { resolveConfigDir, marketplaceDir, codexSkillsDir, codexInstall, codexUninstall, codexStatus, setCodexRunner, ADAPTER_VERSION, type CodexRunner } from "../../src/adapters/codex/install.ts";
```

At the end of the file add:

```ts
import { SKILLS as CODEX_SKILLS } from "../../src/skills/index.ts";

test("install delivers self-doc skills to $HOME/.agents/skills; uninstall removes them", () => {
  const fake = makeFakeCodex();
  setCodexRunner(fake.run);
  const origHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-codex-home-"));
  process.env.HOME = home;
  try {
    const ctx = { ...ictx(tmpCfg(), tmpState()), skills: true };
    const rec = codexInstall(ctx);
    for (const s of CODEX_SKILLS) {
      expect(fs.existsSync(path.join(home, ".agents", "skills", "agmux", s.name, "SKILL.md"))).toBe(true);
    }
    expect(rec.artifacts.some((a) => a.kind === "file" && a.path === codexSkillsDir())).toBe(true);
    codexUninstall(ctx, rec);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "agmux"))).toBe(false);
  } finally {
    process.env.HOME = origHome;
    setCodexRunner(null);
  }
});

test("install --no-skills omits codex skills", () => {
  const fake = makeFakeCodex();
  setCodexRunner(fake.run);
  const origHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-codex-home-"));
  process.env.HOME = home;
  try {
    codexInstall({ ...ictx(tmpCfg(), tmpState()), skills: false });
    expect(fs.existsSync(path.join(home, ".agents", "skills", "agmux"))).toBe(false);
  } finally {
    process.env.HOME = origHome;
    setCodexRunner(null);
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/adapters && bun test tests/adapters/codex.test.ts -t "self-doc skills"`
Expected: FAIL — `codexSkillsDir` is not exported / skills not written.

- [ ] **Step 4: Implement skill materialization in codexInstall**

In `packages/adapters/src/adapters/codex/install.ts`:

Update the type import (line 5) to include `InstallArtifact`, and add the compose import after the plugin-files import (line 7):

```ts
import type { InstallContext, InstallRecord, InstallStatus, InstallArtifact } from "../../core/types.ts";
```
```ts
import { MARKETPLACE_FILES, PLUGIN_VERSION, MARKETPLACE_NAME, PLUGIN_NAME } from "./plugin-files.ts";
import { writeSkills } from "../../skills/compose.ts";
```

Add the skills-dir resolver next to `marketplaceDir` (after line 48):

```ts
// Codex auto-discovers personal skills from $HOME/.agents/skills — NOT CODEX_HOME
// (spec §3.2). Host-global, so it is shared across codex profiles. Reads
// process.env.HOME first so tests can isolate to a temp home.
export function codexSkillsDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".agents", "skills", "agmux");
}
```

Replace the `return { ... }` block of `codexInstall` (lines 68-78) with:

```ts
  const artifacts: InstallArtifact[] = [
    { kind: "config-key", path: configToml, detail: `plugin ${PLUGIN_REF}`, restore: null },
    { kind: "config-key", path: configToml, detail: `marketplace ${MARKETPLACE_NAME}`, restore: null },
  ];
  if (ctx.skills !== false) {
    artifacts.push({ kind: "file", path: writeSkills(codexSkillsDir()), detail: "codex skills agmux/" });
  }
  return {
    agentKind: "codex",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: CODEX_CAPABILITIES,
    artifacts,
  };
```

Update `codexUninstall` (lines 81-85) to also remove file artifacts:

```ts
export function codexUninstall(ctx: InstallContext, record: InstallRecord): void {
  const env = { CODEX_HOME: resolveConfigDir(ctx) };
  runner(["plugin", "remove", PLUGIN_REF], env);
  runner(["plugin", "marketplace", "remove", MARKETPLACE_NAME], env);
  // Remove host-global skill files recorded in the ledger (last-uninstall-wins, spec §3.2).
  for (const a of record.artifacts) {
    if (a.kind === "file") fs.rmSync(a.path, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: Run the codex tests to verify they pass**

Run: `cd packages/adapters && bun test tests/adapters/codex.test.ts`
Expected: PASS (all codex tests, including the two new ones and the unchanged conformance test).

- [ ] **Step 6: Sanity-check that tests used the temp home seam**

Run: `ls ~/.agents/skills/agmux 2>/dev/null && echo "unexpected — check the HOME seam" || echo "clean"`
Expected: `clean` (skill tests point `process.env.HOME` at a temp dir; marketplace tests use `skills: false`).

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/adapters/codex/install.ts packages/adapters/tests/adapters/codex.test.ts
git commit -m "adapters: deliver agmux self-doc skills for codex (host-global)"
```

---

## Task 5: Pi skill delivery (config-dir isolated)

**Files:**
- Modify: `packages/adapters/src/adapters/pi/install.ts`
- Test: `packages/adapters/tests/adapters/pi.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to pi.test.ts)**

At the end of `packages/adapters/tests/adapters/pi.test.ts`, add:

```ts
import { piSkillsDir } from "../../src/adapters/pi/install.ts";
import { SKILLS as PI_SKILLS } from "../../src/skills/index.ts";

test("install delivers self-doc skills into <configDir>/skills/agmux; uninstall removes them", () => {
  const cfg = tmpCfg();
  const ctx = { ...ictx(cfg, tmpState()), skills: true };
  const rec = piInstall(ctx);
  for (const s of PI_SKILLS) {
    expect(fs.existsSync(path.join(piSkillsDir(cfg), s.name, "SKILL.md"))).toBe(true);
  }
  expect(rec.artifacts.some((a) => a.kind === "file" && a.path === piSkillsDir(cfg))).toBe(true);
  piUninstall(ctx, rec);
  expect(fs.existsSync(piSkillsDir(cfg))).toBe(false);
});

test("install --no-skills omits pi skills but still writes the extension", () => {
  const cfg = tmpCfg();
  piInstall({ ...ictx(cfg, tmpState()), skills: false });
  expect(fs.existsSync(piSkillsDir(cfg))).toBe(false);
  expect(fs.existsSync(path.join(extensionsDir(cfg), "agmux.ts"))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/adapters && bun test tests/adapters/pi.test.ts -t "self-doc skills"`
Expected: FAIL — `piSkillsDir` is not exported / skills not written.

- [ ] **Step 3: Implement skill materialization in piInstall**

In `packages/adapters/src/adapters/pi/install.ts`:

Update the type import (line 4) to include `InstallArtifact`, and add the compose import after the extension-files import (line 6):

```ts
import type { InstallContext, InstallRecord, InstallStatus, InstallArtifact } from "../../core/types.ts";
```
```ts
import { EXTENSION_FILES, EXTENSION_FILENAME, PLUGIN_VERSION } from "./extension-files.ts";
import { writeSkills } from "../../skills/compose.ts";
```

Add the skills-dir resolver next to `extensionsDir` (after line 23):

```ts
// Pi auto-discovers skills from <configDir>/skills/ recursively (spec §3.3) —
// config-dir isolated, like Claude. Group under agmux/ for a single uninstall artifact.
export function piSkillsDir(configDir: string): string {
  return path.join(configDir, "skills", "agmux");
}
```

Replace the `return { ... }` block of `piInstall` (lines 48-55) with:

```ts
  const artifacts: InstallArtifact[] = [
    { kind: "file", path: extensionPath(configDir), detail: "pi extension agmux.ts" },
  ];
  if (ctx.skills !== false) {
    artifacts.push({ kind: "file", path: writeSkills(piSkillsDir(configDir)), detail: "pi skills agmux/" });
  }
  return {
    agentKind: "pi",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: PI_CAPABILITIES,
    artifacts,
  };
```

Update `piUninstall` (lines 58-64) so artifact removal is recursive (the skills artifact is a directory; the extension artifact is a file — `recursive: true` is safe for both):

```ts
export function piUninstall(_ctx: InstallContext, record: InstallRecord): void {
  // Remove only recorded artifacts (extension file + skills dir) — never the
  // extensions/ dir itself, which may hold user/other-profile extensions.
  for (const a of record.artifacts) {
    if (a.kind === "file") fs.rmSync(a.path, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the pi tests to verify they pass**

Run: `cd packages/adapters && bun test tests/adapters/pi.test.ts`
Expected: PASS (all pi tests, including the new ones and the unchanged `extensionsDir` survival + conformance tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/adapters/pi/install.ts packages/adapters/tests/adapters/pi.test.ts
git commit -m "adapters: deliver agmux self-doc skills for pi (config-dir)"
```

---

## Task 6: CLI `--no-skills` flag

**Files:**
- Modify: `packages/cli/src/adapter-cmd.ts`
- Test: `packages/cli/tests/adapter-cmd.test.ts` (create)

- [ ] **Step 1: Write the failing integration test**

Create `packages/cli/tests/adapter-cmd.test.ts` (uses the real claude adapter, which is pure filesystem — no external binary needed):

```ts
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAdapterCmd } from "../src/adapter-cmd.ts";
import { createDefaultRegistry } from "@agmux/adapters";

function tmp(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeDeps(stateDir: string) {
  return {
    registry: createDefaultRegistry(),
    stateDir,
    configPath: path.join(stateDir, "no-such-config.toml"), // absent => empty profiles
    agmuxEmitPath: "/abs/agmux emit",
    out: (_l: string) => {},
  };
}

test("adapter install delivers skills by default (claude)", async () => {
  const cfg = tmp("agmux-cli-cfg-");
  const code = await runAdapterCmd(["install", "--kind", "claude", "--config-dir", cfg], makeDeps(tmp("agmux-cli-state-")));
  expect(code).toBe(0);
  expect(fs.existsSync(path.join(cfg, "skills", "agmux", "skills", "agmux-overview", "SKILL.md"))).toBe(true);
});

test("adapter install --no-skills omits skills but still installs the plugin", async () => {
  const cfg = tmp("agmux-cli-cfg-");
  const code = await runAdapterCmd(["install", "--kind", "claude", "--config-dir", cfg, "--no-skills"], makeDeps(tmp("agmux-cli-state-")));
  expect(code).toBe(0);
  expect(fs.existsSync(path.join(cfg, "skills", "agmux", ".claude-plugin", "plugin.json"))).toBe(true);
  expect(fs.existsSync(path.join(cfg, "skills", "agmux", "skills"))).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/cli && bun test tests/adapter-cmd.test.ts`
Expected: FAIL on the second test — `--no-skills` is currently treated as an unknown arg; `resolveTarget` would error or skills still get written.

- [ ] **Step 3: Implement the flag**

In `packages/cli/src/adapter-cmd.ts`:

Add a flag-stripping helper after `takeConfigDir` (after line 54):

```ts
// Strip a boolean flag and report whether it was present.
function takeFlag(args: string[], flag: string): { rest: string[]; present: boolean } {
  const i = args.indexOf(flag);
  if (i < 0) return { rest: args, present: false };
  return { rest: [...args.slice(0, i), ...args.slice(i + 1)], present: true };
}
```

Update `ctxFor` (lines 39-45) to take a `skills` argument:

```ts
function ctxFor(t: Target, deps: AdapterCmdDeps, configDirOverride: string | null, skills: boolean = true): InstallContext {
  return {
    agentKind: t.agentKind, profile: t.profile, profileEnv: t.profileEnv,
    agmuxEmitPath: deps.agmuxEmitPath, stateDir: deps.stateDir,
    configDirOverride, skills,
  };
}
```

In the `install|uninstall|status` block, replace the arg-parsing lines (lines 84-89) with:

```ts
    const { rest: afterCfg, configDir } = takeConfigDir(rest);
    const { rest: targetArgs, present: noSkills } = takeFlag(afterCfg, "--no-skills");
    const t = resolveTarget(targetArgs, cfg);
    if ("error" in t) { deps.out(t.error); return 2; }
    const adapter = deps.registry.lookup(t.agentKind);
    if (!adapter) { deps.out(`no adapter registered for kind '${t.agentKind}'`); return 1; }
    const ctx = ctxFor(t, deps, configDir, !noSkills);
```

Update the usage line (line 107):

```ts
  deps.out("usage: agmux adapter list|install|status|uninstall (<profile> | --kind <agent_kind>) [--config-dir <path>] [--no-skills]");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/cli && bun test tests/adapter-cmd.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/adapter-cmd.ts packages/cli/tests/adapter-cmd.test.ts
git commit -m "cli: add --no-skills opt-out to adapter install"
```

---

## Task 7: Deferred (B) handoff doc

**Files:**
- Create: `docs/backlog/05-skill-bundling-runner.md`

- [ ] **Step 1: Write the handoff doc**

Create `docs/backlog/05-skill-bundling-runner.md`:

```markdown
# Backlog 05 — Runner-time skill bundling (deferred from Pitch 04)

**Status:** Deferred. Spun off from [Pitch 04](04-skill-delivery-bundling.md), scope (B).
**Prereq context:** [Skill delivery design](../superpowers/specs/2026-06-19-agmux-skill-delivery-design.md) (scope A, shipped) and [agmux-foundation](../agmux-foundation.md) §4–§5, §7–§8, §12.

## What shipped (scope A)
Install-time delivery of agmux's own self-documentation skills (`agmux-overview`,
`agmux-troubleshooting`) via `adapter install`, for Claude, Codex, and Pi. Single
catalog in `@agmux/adapters/src/skills/`. See the design doc.

## What this branch is for (scope B)
Runner-time bundling of ARBITRARY skills into ANY kind/profile at `agmux run`,
plus the skill content that needs functionality we do not have yet.

### Work items
1. **Runtime injection.** Inject skills at launch, not just install:
   - Pi: `--skill <path>` (repeatable; additive even with `--no-skills`).
   - Claude: `--plugin-dir <bundle>` + `.claude-plugin/plugin.json`, and bundle-only
     suppression of host skills if wanted (no `--setting-sources` for skills today —
     re-verify against current Claude Code).
   - Codex: re-use the install-time `$HOME/.agents/skills` path or a launch flag if one exists.
2. **Per-profile enable/disable filters** (the omnigent `skills_filter` analogue) with a
   `config.toml` surface; compose with `@agmux/wrapper` profile resolution and the launcher
   (Pitches 02/03).
3. **Orchestration / comms skills.** Author AFTER `@agmux/comms` exists — teach
   `send_message` / `check_inbox` / `ask` / `reply` / `notify`, all stamping
   `AGMUX_SESSION_ID` (Foundation §5). These were intentionally NOT shipped in scope A
   because the functionality does not exist.
4. **Package question.** Decide whether the catalog graduates from `@agmux/adapters`
   into a dedicated `@agmux/skills` package once it has a second (runtime) consumer.

### Reference
omnigent `inner/bundle_skills.py` is the prior art for `--plugin-dir`/filter bundling
(grep the repo at https://github.com/omnigent-ai/omnigent; lines drift).

~by Claude Code [•_•]
```

- [ ] **Step 2: Commit**

```bash
git add docs/backlog/05-skill-bundling-runner.md
git commit -m "docs: handoff for deferred runner-time skill bundling (scope B)"
```

---

## Task 8: Full verification + live Claude spike

**Files:** none (verification only).

- [ ] **Step 1: Run the full adapters + cli test suites**

Run: `cd packages/adapters && bun test`
Expected: PASS — all suites green, including the pre-existing claude/codex/pi conformance batteries.

Run: `cd packages/cli && bun test`
Expected: PASS.

- [ ] **Step 2: Typecheck the touched packages**

Run: `cd packages/adapters && bunx tsc --noEmit && cd ../cli && bunx tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 3: Sanity-check the temp-home seam held across the suite**

Run: `ls ~/.agents/skills/agmux 2>/dev/null && echo "unexpected — check the HOME seam" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Live Claude spike — install into a scratch config dir**

> Requires the `claude` binary on PATH. If unavailable, record this step as a deferred follow-up (as the codex/pi adapters did for their live smoke-tests) and stop here.

Build/resolve the agmux CLI entry (per the repo's run instructions), then:

```bash
SCRATCH=$(mktemp -d)
agmux adapter install --kind claude --config-dir "$SCRATCH"
ls "$SCRATCH/skills/agmux/skills"
# Expected: agmux-overview  agmux-troubleshooting
cat "$SCRATCH/skills/agmux/skills/agmux-overview/SKILL.md" | head -5
# Expected: --- / name: agmux-overview / description: "..." / --- / (blank)
```

- [ ] **Step 5: Live Claude spike — confirm listing + invocation**

```bash
CLAUDE_CONFIG_DIR="$SCRATCH" claude
```

In the session: confirm the skills appear (e.g. via `/` skill listing or asking Claude what agmux skills it has) labeled `agmux:agmux-overview` and `agmux:agmux-troubleshooting`, and that invoking `agmux-overview` yields guidance that references `$AGMUX_SESSION_ID`.

Record the result (listed? invocable? label correct?) in the spec's §8 or a short note. Clean up: `rm -rf "$SCRATCH"`.

- [ ] **Step 6: Final commit (if any notes/docs updated)**

```bash
git add -A
git commit -m "docs: record live claude skill-delivery spike result"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 skills → Task 1 (content) ; §2 catalog → Task 1 ; §3.1 Claude → Task 3 ; §3.2 Codex (host-global + caveat) → Task 4 ; §3.3 Pi → Task 5 ; §4 naming (`agmux-` prefix) → Task 1 Steps 5-6 ; §5 install + `--no-skills` → Tasks 2, 6 ; §6 version/drift reuse → covered by existing `status()` (no code change; asserted by existing drift tests still passing in Task 8) ; §7 capability matrix → Task 1 Step 9 ; §8 tests → Tasks 1,3,4,5,6 ; §8 live spike → Task 8 ; §9 (B) handoff → Task 7 ; §10 out-of-scope → respected (no runner/launcher/comms changes). All covered.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output.

**Type consistency:** `SkillDef{name,description,body}`, `skillFileContent(def)`, `writeSkills(baseDir, skills?)`, `SkillSurface`, `SKILL_SURFACES`, `codexSkillsDir()`, `piSkillsDir(configDir)`, `ctx.skills`, `takeFlag()`, `ctxFor(...,skills)` are used identically across tasks. `writeSkills` returns `baseDir` and is recorded as a single `file` artifact in codex/pi; for claude it nests under the already-recorded plugin dir (no extra artifact). Consistent.
