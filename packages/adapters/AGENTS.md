# AGENTS.md — `@agmux/adapters`

Adapter framework (per-agent install/uninstall/status + ledger) and the **skill catalog** shipped into agent sessions. Design: [`docs/superpowers/specs/2026-06-19-agmux-skill-delivery-design.md`](../../docs/superpowers/specs/2026-06-19-agmux-skill-delivery-design.md). Deferred runtime injection (scope B): [`docs/backlog/05-skill-bundling-runner.md`](../../docs/backlog/05-skill-bundling-runner.md).

## Skill delivery

agmux ships its own skills (agent-facing `SKILL.md` docs) as part of `agmux adapter install`. **One catalog, materialized per-adapter** — never author skill content inside an adapter.

- **Single source of truth:** `src/skills/`. `catalog.ts` exports `SKILLS: SkillDef[]`; each skill is a `SkillDef {name, description, body}` in its own file.
- **Content is embedded code, not `.md` data files** — bodies are exported template literals, so the catalog works identically from source and from a `bun build --compile` binary (like `plugin-files.ts` / `extension-files.ts`). **No backticks in bodies** (enforced by test).
- `compose.ts`: `skillFileContent(def)` → canonical `SKILL.md` (`---`/`name`/`description` JSON-encoded/`---`/body). `writeSkills(baseDir, skills?)` writes `<baseDir>/<name>/SKILL.md` for each and returns `baseDir` (so callers record it as one uninstall artifact).
- **Skills are informational only** — they instruct the agent; they do not emit events. Only §5 touchpoint: identity lives in `$AGMUX_SESSION_ID`.
- **Verify every command/env var against the real CLI** at authoring time (`packages/cli`). Do not invent verbs.

## Adding a new skill

1. `src/skills/<name>.ts` — export a `SkillDef`. `name` is kebab-case, prefixed `agmux-` (it shares the user's flat namespace on Codex/Pi). `description` drives auto-triggering, ≤1536 chars, trigger condition first. Body: markdown, 4-space-indented code blocks (no backticks).
2. Add it to `SKILLS` in `catalog.ts`. That's the only wiring — all three adapters already call `writeSkills(...)`, so it materializes everywhere automatically.
3. Extend `tests/skills.test.ts` if the skill has invariants worth pinning; the generic catalog assertions (unique names, non-empty fields, budget-safe description, no backticks) already cover it.
4. `cd packages/adapters && bun test` — the per-adapter tests assert the new `SKILL.md` lands in each discovery dir.

## Per-adapter materialization (`SKILL_SURFACES` in `surface.ts` is the source + conformance check)

| kind | dir | isolation | label |
|---|---|---|---|
| claude | `<configDir>/skills/agmux/skills/<name>/` (nested in the telemetry plugin) | config-dir (per-profile) | `agmux:<name>` |
| codex | `$HOME/.agents/skills/agmux/<name>/` | **host-global** — discovery keys off `$HOME`, not `CODEX_HOME` | `<name>` |
| pi | `<configDir>/skills/agmux/<name>/` | config-dir (per-profile) | `<name>` |

Wiring lives in each `adapters/<kind>/install.ts`: a `writeSkills(<kind>SkillsDir(...))` call gated on `ctx.skills !== false`. Claude nests skills under the plugin dir its uninstall already `rm -rf`s (no extra artifact). Codex/Pi record the skills dir as a `{kind:"file"}` artifact and uninstall removes recorded `file` artifacts — never the shared parent (`skills/`, `extensions/`). Codex is last-uninstall-wins across profiles (host-global).

## Contracts

- **Opt-out:** `InstallContext.skills?: boolean` (default undefined = deliver). CLI `agmux adapter install ... --no-skills` sets it false → telemetry only. Gate is always `ctx.skills !== false` (omitted must deliver — there are tests pinning the omitted path; don't narrow to `=== true`).
- **Versioning/drift:** skills ride the adapter's existing payload version (`PLUGIN_VERSION` in `plugin-files.ts` / `extension-files.ts`). Per spec §6, bump it when skill content changes **in a released adapter** so `status()` reports drift. Iterating content within an unreleased branch needs no intermediate bump.
- **New agent kind with no skill surface:** give it a `SKILL_SURFACES` entry with `installTime:false`; install degrades gracefully (skips skills). The `Record<AgentKind, SkillSurface>` type makes a missing entry a compile error.

## Out of scope (here)

Runtime `--skill` injection, per-profile enable/disable filters, orchestration/comms skills → scope B (see backlog 05). Keep the catalog in this package until a second (runtime) consumer justifies a dedicated `@agmux/skills`.
