# agmux — Skill Delivery (self-documentation skills) Design

**Date:** 2026-06-19
**Status:** Design (spec). Scope **(A)** of [Pitch 04 — Skill delivery via the plugin/bundle convention](../../backlog/04-skill-delivery-bundling.md). Realizes Foundation §4–§5, §12 ("services and **skills**").
**Builds on:** [`2026-05-29-adapters-framework-design.md`](2026-05-29-adapters-framework-design.md) (the `Adapter` abstraction + per-target ledger), [`2026-05-29-adapter-claude-design.md`](2026-05-29-adapter-claude-design.md) (filesystem-only, embedded-payload install), [`2026-06-15-adapter-codex-design.md`](2026-06-15-adapter-codex-design.md), [`2026-06-18-adapter-pi-design.md`](2026-06-18-adapter-pi-design.md). The `Adapter` interface, `install/uninstall/status`, embedded-payload pattern, per-target ledger, and conformance harness already exist and are reused unchanged in shape.

---

## 0. Scope & framing

The pitch splits naturally into two efforts. This branch is **(A) only**:

- **(A) — agmux skills shipped with `adapter install`** (this branch). agmux authors a small set of skills that teach an agent **how to use agmux itself** — orient via the CLI, and diagnose/troubleshoot agmux. They are delivered as part of the per-agent `adapter install`, reusing each adapter's existing skill surface.
- **(B) — runner-time skill bundling** (deferred). `agmux run`-time injection of *arbitrary* skills into *any* kind/profile, per-profile enable/disable filters, Pi `--skill`/`--no-skills`, `--plugin-dir`/setting-source suppression, and orchestration/comms skills. Deferred until the underlying functionality (comms/orchestration) exists. Captured in a handoff doc (§9) for a future worktree.

**Key prior-art correction:** the pitch recommends lift-and-porting omnigent's `bundle_skills.py` to "build the plugin/bundle plumbing." That plumbing **already exists in agmux** — the Claude adapter already writes a skills-directory plugin (`<configDir>/skills/agmux/.claude-plugin/plugin.json` + `hooks/`) for telemetry. This branch **extends the already-shipped plugin payload** to also carry `SKILL.md` files; it does not build new bundling machinery or a launcher flag. agmux's auto-discovery placement is strictly simpler than omnigent's `--plugin-dir` handoff.

**Verification scope (decided):** full unit + conformance coverage for the catalog and per-adapter materialization. A **live Claude smoke-test** (skills listed + invocable in a real session) is in scope. Codex/Pi live tests follow the precedent of their adapters (Codex was initially library-only; Pi's live test deferred) — Codex gets a filesystem-level assertion; Pi is out of scope (deferred to B).

---

## 1. What we ship: two self-documentation skills

A skill is a directory with `SKILL.md` (+ YAML frontmatter `name`, `description`) — the **same authoring format for both Claude and Codex** (verified against [code.claude.com/docs/skills](https://code.claude.com/docs/en/skills) and [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills)). `description` drives automatic triggering and is budget-capped (Claude: combined ≤1536 chars); keep it tight and put the trigger condition first.

| name | purpose | trigger intent |
|---|---|---|
| **`agmux-overview`** | What agmux is (session capture → hub → append-only event log; profiles vs `agent_kind`) and the **read-only** CLI an agent uses to orient itself: `agmux ls`, `agmux watch`, `agmux inspect <id>`, `agmux dash`. Teaches that the current session's canonical id is in **`$AGMUX_SESSION_ID`** and that `agmux inspect $AGMUX_SESSION_ID` shows the agent its own record (Foundation §5). | "what is agmux / how do I see sessions / what's my session id" |
| **`agmux-troubleshooting`** | Diagnosing agmux: is the hub running and reachable (`AGMUX_HUB_URL`); how to restart it; reading `agmux adapter status` for install/drift; where state/queue/cursors live (`~/.agmux/…`); common failure modes (hook not firing, ingest queue backlog, missing `AGMUX_SESSION_ID`). | "agmux isn't recording / hub down / events missing / adapter drift" |

**No orchestration or comms skills** — that functionality does not exist yet (Foundation §7–§8). Adding skills that teach unbuilt features would be speculative; they belong to a later branch alongside the feature.

Both skills are **informational** — they instruct the agent, they do not emit events. The only §5 touchpoint is teaching the agent that its identity lives in `$AGMUX_SESSION_ID`. Skill content must be verified against the *current* CLI surface at authoring time (commands and flags are taken from `@agmux/cli`, not invented).

---

## 2. Single source of truth: the skill catalog

All skill content lives in **one place** in `@agmux/adapters`, decoupled from any single agent: `packages/adapters/src/skills/`.

```
packages/adapters/src/skills/
  catalog.ts          // export const SKILLS: SkillDef[]  — the registry
  agmux-overview.ts   // export const body = `…markdown…`
  agmux-troubleshooting.ts
  compose.ts          // skillFileContent(def) -> SKILL.md text (frontmatter + body)
```

```ts
export interface SkillDef {
  name: string;          // dir name + frontmatter name; also the Codex label
  description: string;   // frontmatter description; drives triggering; ≤1536 chars
  body: string;          // SKILL.md markdown (no frontmatter — compose() adds it)
}
```

**Embedded as code, not on-disk data files.** Bodies are exported template literals (matching `plugin-files.ts` / `extension-files.ts`), so the catalog works identically from source and from a `bun build --compile` binary (where `import.meta.dir` is virtual and data files don't exist). This is a deliberate consistency choice over `.md` + Bun text-import: zero new build risk, identical to every other shipped-payload in the package.

`compose(def)` emits canonical `SKILL.md` text:

```
---
name: <def.name>
description: <def.description>
---

<def.body>
```

Each consuming adapter imports `SKILLS` and `compose` — the catalog is authored once and materialized per-adapter. The same composed text satisfies both Claude and Codex frontmatter requirements.

---

## 3. Per-adapter materialization

Each adapter's existing `install()` is extended to also materialize the catalog into that agent's skill-discovery location, controlled by an install option (§5). `uninstall()` removes them via the ledger; `status()`/drift is covered by the existing version bump (§6).

### 3.1 Claude — nested in the existing plugin (per-profile isolated)

The Claude adapter already writes a plugin to `<configDir>/skills/agmux/`. Skills nest **inside** it:

```
<configDir>/skills/agmux/
  .claude-plugin/plugin.json     (existing)
  hooks/hooks.json               (existing)
  bin/agmux-emit                 (existing)
  skills/
    agmux-overview/SKILL.md      (new)
    agmux-troubleshooting/SKILL.md
```

Verified behavior (claude-code-guide, docs as of 2026-06-19): a plugin auto-discovered from `~/.claude/skills/<name>/` exposes its bundled `skills/<n>/SKILL.md` files, **labeled `agmux:<name>`** (plugin-namespaced). No marketplace, no `--plugin-dir`, no launcher flag — the skills appear on the next session via the same auto-discovery that already loads the telemetry hooks. Because they live under the resolved `configDir`, they are **per-profile isolated** for free (a `claude-work` profile pointing at a different `CLAUDE_CONFIG_DIR` gets its own copy).

### 3.2 Codex — host-global personal skills (`$HOME/.agents/skills`)

Codex auto-discovers personal skills from **`$HOME/.agents/skills`** (among `$CWD/.agents/skills`, repo root, `/etc/codex/skills`, bundled). Materialize to:

```
$HOME/.agents/skills/agmux/
  agmux-overview/SKILL.md
  agmux-troubleshooting/SKILL.md
```

Labeled by the `name` field, **no plugin namespacing** — they sit alongside the user's own personal skills (hence the `agmux-` name prefix, §4).

**Isolation caveat (decided, documented):** Codex skill discovery keys off `$HOME`, **not `CODEX_HOME`/`--config-dir`**. `config.toml` only enables/disables existing skills by path; it cannot add discovery roots. Therefore Codex agmux-skills are **host-global**, not per-profile isolated. Consequences, all acceptable for identical low-stakes self-docs:
- Two Codex profiles share one copy; install is an idempotent refresh.
- `uninstall` removes the shared `$HOME/.agents/skills/agmux/` dir → **last-uninstall-wins** across profiles (reinstall any profile restores them).
- The per-profile ledger still records the (shared) skill artifacts so uninstall knows what to remove.

This divergence (host-global vs Claude's config-dir-isolated) is recorded in the capability matrix (§7) — it is a Codex platform fact, not an agmux choice.

### 3.3 Pi — deferred to (B)

Pi exposes skills via the **runtime `--skill <path>` / `--no-skills`** launch flags (per the pitch), i.e. a *runner* concern, not an install-time auto-discovery directory. There is no `<configDir>` skills dir analogous to Claude's plugin `skills/` or Codex's `$HOME/.agents/skills`. Pi skill delivery therefore belongs to **(B)** and is deferred. The plan includes a one-line re-confirmation against current Pi docs/code; if an install-time discovery dir is found to exist, Pi can be added with no change to the catalog or composer.

---

## 4. Naming

Catalog names are prefixed: **`agmux-overview`**, **`agmux-troubleshooting`**.

- On **Codex** they share the user's flat personal-skill namespace, so the prefix marks ownership and avoids collisions (Codex does not merge same-named skills — both would appear).
- On **Claude** they read `agmux:agmux-overview` (the plugin already namespaces with `agmux:`). The doubled token is cosmetically redundant but unambiguous and harmless — a single catalog name across both surfaces is worth more than per-surface renaming.

---

## 5. Install integration & opt-out

- Skills are delivered as part of the **existing** `adapter install` flow — no new command. They inherit each adapter's `InstallContext` (config-dir resolution, profile, ledger).
- **`--no-skills` opt-out** on `adapter install` (and the programmatic `installAdapter` option): default = deliver skills; `--no-skills` installs only the telemetry payload. Respects user control (Foundation principle: optional/additive). The flag is threaded through `adapter-cmd.ts` → `installAdapter` → `adapter.install(ctx)` via an `InstallContext` field (e.g. `ctx.skills: boolean`, default true).
- Materialized `SKILL.md` files are appended to the `InstallRecord.artifacts` list (`kind: "file"`) so `uninstall` removes them through the existing ledger-driven teardown. For Claude they fall under the already-removed plugin dir; for Codex they are the explicit `$HOME/.agents/skills/agmux/` artifact.

---

## 6. Versioning & drift

Skill content changes are versioned by the **existing plugin/payload version**, so the existing `status()` drift detection covers skills with no new machinery:

- **Claude:** bump `PLUGIN_VERSION` (in `plugin-files.ts`) when any skill body/description changes — `status()` already reads `plugin.json`'s `version` and reports `drift`.
- **Codex:** the marketplace/payload `PLUGIN_VERSION` similarly bumps; Codex `status()` already compares it. (Codex skills carry no separate version marker; the adapter payload version is the single drift signal.)

Because skills are part of the adapter payload, "skill content changed" and "adapter needs reinstall" are the same signal — desirable, not a limitation.

---

## 7. Capability matrix (single source + doc)

A small static descriptor records each kind's install-time skill surface — one source feeding both a docs table and a conformance test. Shape (illustrative):

```ts
export interface SkillSurface {
  installTime: boolean;             // can adapter install deliver skills?
  mechanism: "plugin-skills-dir" | "personal-skills-dir" | "runtime-flag" | "none";
  isolation: "config-dir" | "host-global" | "n/a";
  label: string;                    // e.g. "agmux:<name>" | "<name>"
  note?: string;
}
```

| `agent_kind` | installTime | mechanism | isolation | label | this branch |
|---|---|---|---|---|---|
| **claude** | ✅ | `plugin-skills-dir` (`<configDir>/skills/agmux/skills/`) | config-dir | `agmux:<name>` | **delivers both** |
| **codex** | ✅ | `personal-skills-dir` (`$HOME/.agents/skills/agmux/`) | host-global | `<name>` | **delivers both** |
| **pi** | ❌ (runtime `--skill` only) | `runtime-flag` | n/a | n/a | **deferred → (B)** |

This directly serves Foundation's *agent-agnostic-by-construction* principle: where a kind lacks the surface, install **degrades gracefully** (skips skills, no error), and the gap is recorded rather than hidden.

---

## 8. Testing

Library/unit + conformance (Bun test, `packages/adapters/tests/`):

1. **Catalog:** every `SkillDef` has non-empty `name`/`description`/`body`; names unique; `description` ≤1536 chars; `compose()` emits valid frontmatter (parseable YAML, `name`+`description` present, body preserved).
2. **Claude install:** with default options, `SKILL.md` files appear at `<configDir>/skills/agmux/skills/<name>/`; `--no-skills` omits them; artifacts recorded in the record; uninstall removes them; bumping `PLUGIN_VERSION` → `status().drift === true`.
3. **Codex install:** `SKILL.md` files appear at `$HOME/.agents/skills/agmux/<name>/` (test against a temp `$HOME`); `--no-skills` omits; artifacts recorded; uninstall removes the dir.
4. **Capability matrix:** every `AgentKind` has a `SkillSurface` descriptor; values match the documented matrix; `pi.installTime === false`.
5. **Conformance:** existing adapter conformance harness still passes with the extended install.

**Live spike (Claude, the pitch's named deliverable):** install into a scratch `CLAUDE_CONFIG_DIR`, launch a real `claude` session, confirm `agmux:agmux-overview` and `agmux:agmux-troubleshooting` are listed and invocable, and that invoking `agmux-overview` yields guidance referencing `$AGMUX_SESSION_ID`.

---

## 9. Deferred (B) — runner-bundling handoff

A standalone handoff doc (`docs/backlog/05-skill-bundling-runner.md` or `docs/handoffs/…`) for a future worktree, capturing:

- `agmux run`-time injection of arbitrary skills into any kind/profile (vs install-time self-docs).
- Per-profile **enable/disable filters** (the omnigent `skills_filter` analogue) and a config surface in `config.toml`.
- **Pi** `--skill <path>` / `--no-skills` launcher wiring; Claude `--plugin-dir`/setting-source suppression if a "bundle-only" mode is ever wanted.
- Orchestration/comms skills — authored **after** `@agmux/comms` exists, teaching `send_message`/`check_inbox`/`ask`/`reply`/`notify`, all stamping `AGMUX_SESSION_ID` (§5).
- Whether (B) warrants a dedicated `@agmux/skills` package (the catalog could graduate out of `@agmux/adapters` once it serves both install-time and run-time consumers).

---

## 10. Out of scope (this branch)

- Any `@agmux/skills` package (catalog stays in `@agmux/adapters`; extract only when (B) gives it a second consumer).
- Runner/launcher changes (`agmux run`, profiles config) — pure (B).
- Pi skill delivery.
- Orchestration/comms skills.
- User-authored skill sourcing (only agmux-shipped skills here).

## 11. Deliverables

1. This spec.
2. Implementation plan → `docs/plans/pitch-04-skill-delivery-bundling.plan.md`.
3. Implementation: skill catalog + Claude & Codex materialization + capability matrix + `--no-skills` + tests, per the plan.
4. (B) handoff doc (§9).
5. Live Claude spike confirming listing + invocation.
