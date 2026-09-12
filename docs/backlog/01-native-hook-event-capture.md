# Pitch 01 — Native-hook adapter & normalized payload bridge

**Source:** omnigent · **Target package(s):** `@agmux/adapters`, `@agmux/protocol` · **agmux concern:** in-session capture (monitoring)

---

## Handoff context (read first)

agmux is a local-first hub that records every AI-agent session (Claude Code, Codex, Gemini, opencode, pi…)
as an append-only event log and exposes it to opt-in consumers. It is **not** a meta-harness — it provides
mechanics that live *inside* the existing agents. Read [`../agmux-foundation.md`](../agmux-foundation.md)
(esp. §4 capture model, §5 identity, §6 data model) and
[`../superpowers/specs/2026-06-05-native-first-design.md`](../superpowers/specs/2026-06-05-native-first-design.md)
(sessions self-register from their own hooks; the hub resolves native identity at ingest).

This is a **design pitch / spike**, not an implementation order. Produce a design doc; flag open questions.

Reference codebase: clone `https://github.com/omnigent-ai/omnigent` and `grep` (line numbers below drift).

## What omnigent does

omnigent instruments a *running* Claude Code / Codex CLI purely through that CLI's own **lifecycle hooks** —
no modification to the agent. For Claude it registers hooks via a `--settings` JSON blob
(`SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `MessageDisplay`,
`TaskCreated/Completed`) at `claude_native_bridge.py:965` (`build_hook_settings`). Codex registers the same
shapes via a `hooks.json` in a private `CODEX_HOME`.

The decisive reusable piece is **`omnigent/native_policy_hook.py`** — a *harness-neutral* translator. Claude
Code and Codex emit nearly **identically-shaped** hook payloads (`hook_event_name`, `tool_name`,
`tool_input`, `tool_output`, `prompt`), so one mapping serves both: `hook_payload_to_evaluation_request`
maps `PreToolUse→TOOL_CALL`, `PostToolUse→TOOL_RESULT`, `UserPromptSubmit→REQUEST`. It also has a deliberate
**fast/slow channel split**: high-frequency text deltas are *appended to a file* (never block streaming),
while rare synchronous decisions use a blocking call.

## Why it matters for agmux

- agmux's `@agmux/adapters` is exactly this layer — "thin per-agent enrichment hooks, each stamping
  `AGMUX_SESSION_ID`" (foundation §12). omnigent has already proven the hook set and payload shapes that yield
  rich in-session events (`tool.used`, `prompt.sent`, token usage) with zero agent modification.
- The cross-harness **normalization table** is directly portable: it lets one adapter contract cover Claude +
  Codex, feeding agmux's typed/versioned event log (§6) instead of omnigent's policy engine.
- Reinforces the native-first identity principle: each hook reads `AGMUX_SESSION_ID` and stamps every event.

## Plan outline

1. Catalogue each harness's hook system (Claude `--settings`/`settings.json` hooks; Codex `hooks.json` + the
   ≥0.129 trust handshake; Gemini/opencode/pi equivalents). Note which emit which events.
2. Port omnigent's payload→event mapping into an agmux `protocol` event-shape table (`tool.used`,
   `prompt.sent`, `session.started`, `compaction`, …), additive & versioned per §6.
3. Define the adapter contract: a tiny stdin→JSON→ingest handler that reads `AGMUX_SESSION_ID`, normalizes,
   and POSTs to the hub ingest API. Adopt omnigent's append-not-block discipline for high-frequency events.
4. Spec self-registration: first hook event resolves/creates the canonical session and records
   `native_session_id` as an attribute.
5. Prototype the Claude adapter end-to-end; verify events land and rebuildable projections update.

## Deliverable

A design doc under `docs/` (per-agent hook matrix + the normalized event mapping + the adapter contract),
plus a working Claude adapter spike feeding the hub. Do **not** copy omnigent's policy-evaluation/server
round-trip — agmux only needs the *capture* half.
