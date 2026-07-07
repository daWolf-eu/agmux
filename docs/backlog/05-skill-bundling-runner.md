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
