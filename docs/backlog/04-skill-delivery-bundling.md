# Pitch 04 — Skill delivery via the plugin/bundle convention

**Source:** omnigent · **Target package(s):** `@agmux/adapters` (possibly a new `@agmux/skills`) · **agmux concern:** capability injection into the agent

---

## Handoff context (read first)

agmux's stated goal is to "provide the underlying mechanics, **services and skills** to enable
functionalities within harnesses themselves." Foundation §5 names skills explicitly as an integration that
must read `AGMUX_SESSION_ID`. This finding is the concrete mechanism for *delivering* a skill into a harness.
Read [`../agmux-foundation.md`](../agmux-foundation.md) §4–§5, §12.

This is a **design pitch / spike**. Reference codebase: `https://github.com/omnigent-ai/omnigent` (grep; lines drift).

## What omnigent does

`omnigent/inner/bundle_skills.py` ships skills into a harness using Claude Code's documented **plugin/skill
convention** — no orchestration layer:

- Materializes `skills/<name>/SKILL.md` files into a bundle dir.
- Writes `<bundle>/.claude-plugin/plugin.json` (`ensure_bundle_plugin_manifest`) so Claude labels skills as
  `<agent>:<skill>`.
- Translates a `skills_filter` into CLI args (`claude_native_skill_args`): emits `--plugin-dir <bundle>` when
  `skills/` exists; `"none" → --setting-sources ""` to suppress the host's `~/.claude/skills`.
- The Claude SDK path mirrors this via `plugins=[{"type":"local","path":bundle}]` + `setting_sources`.
- Pi maps the same filter onto `--skill <path>` / `--no-skills`; **Codex and Cursor have no skill mechanism**
  (a useful capability gap to record).

The repo also dogfoods this: `.claude/skills/cursor-sdk-e2e-dev/SKILL.md` etc. are skills used to build the
harness adapters themselves.

## Why it matters for agmux

- This is the most direct expression of agmux's "skills within harnesses" goal. The recipe is just the host
  CLI's own plugin convention — exactly the kind of mechanic agmux wants to provide, with no meta-harness.
- Lets agmux ship its own skills (e.g. "how to use the comms inbox", orchestration helpers) into any spawned
  session, gated per profile.
- The per-agent capability matrix (who supports skills, who doesn't) feeds agmux's agent-agnostic-by-
  construction principle: degrade gracefully where a harness lacks the surface.

## Plan outline

1. Inventory each `agent_kind`'s skill/plugin surface: Claude (`--plugin-dir` + `.claude-plugin/plugin.json`,
   SDK `plugins=`), Pi (`--skill`), and which agents have none. Mirror omnigent's findings, verify current.
2. Design an agmux skill bundle layout + a launcher step that points the spawned harness at it (composes with
   Pitch 02/03 launcher work).
3. Decide skill *sourcing*: agmux-shipped skills vs user-authored, and per-profile enable/disable.
4. Ensure any agmux skill template references `AGMUX_SESSION_ID` so skill-emitted actions stay joinable (§5).
5. Prototype: deliver one agmux skill into a Claude session and confirm it is listed and invocable.

## Deliverable

A "skill delivery" design doc with the per-agent capability matrix and bundle layout, plus a spike injecting
one skill into a Claude session. `bundle_skills.py` is near lift-and-port for the Claude path — reuse it.
