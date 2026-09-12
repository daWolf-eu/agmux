# Pitch 02 — Reliable prompt injection into tmux CLIs

**Source:** omnigent · **Target package(s):** `@agmux/cli`, `@agmux/hub` (host-agent control role) · **agmux concern:** spawn/bootstrap steering

---

## Handoff context (read first)

agmux records AI-agent sessions and can *control* them: the hub/host-agent can "create tmux panes/windows/
sessions and inject input, not merely read coordinates" (foundation §7). **Injection is reserved for
spawn/bootstrap and one-shot delegation** — ongoing dialogue goes through structured MCP comms, never
keystrokes (§8, §14.9). So this finding is about the *bootstrap injection* path only. Read
[`../agmux-foundation.md`](../agmux-foundation.md) §7.

This is a **design pitch / spike**. Reference codebase: `https://github.com/omnigent-ai/omnigent` (grep; lines drift).

## What omnigent does

omnigent delivers a message into a live `claude` CLI running in a tmux pane via
`inject_user_message` (`omnigent/claude_native_bridge.py:2288`). It is far more than `send-keys`, because naive
keystroke injection breaks in production. The hard-won mechanics:

- **Bracketed-paste via a tmux *buffer*, not argv** — `load-buffer` then `paste-buffer -p -d`. This dodges
  tmux's ~16 KB command-length cap **and** the bug where multi-line text submits once per newline
  (ref `anthropics/claude-code#52126`).
- **Readiness gating** — wait for the pane's prompt glyph (`❯`) before typing, so the first message isn't
  dropped into a still-booting TUI (`:2334`).
- **Verified submit** — poll `capture-pane` until the draft text appears, send `Enter`, re-poll and re-send,
  because Claude coalesces stdin bursts and a fire-and-forget `Enter` silently fails under load (`:2389`).
- **Soft vs hard control** — `send-keys Escape` cancels the in-flight response (`:2425`); `kill-session` ends
  the pane (`:2454`). Two distinct affordances.

Codex-native is the contrast: it steers via the `codex app-server` JSON-RPC (`turn/steer`, `turn/interrupt`),
*not* keystrokes — worth noting where a structured channel exists.

## Why it matters for agmux

- agmux already owns its tmux coordinates (it spawns the pane), so it can skip omnigent's filesystem
  rendezvous and runner tunnel — but the **~140 lines of injection mechanics are the real IP** and are
  exactly what makes "inject a prompt into a spawned pane" (§7) actually work rather than flake intermittently.
- These details are only discoverable by hitting the bugs in production; porting them saves agmux that pain.

## Plan outline

1. Extract the three primitives — buffer-paste delivery, prompt-glyph readiness gate, verified-submit poll —
   as a small TS module in `cli` (or hub host-agent), driven by `tmux` shell-outs.
2. Add the soft-interrupt (Escape) and hard-stop (kill) affordances as explicit verbs.
3. Generalize the readiness glyph per `agent_kind` (Claude `❯`; determine Codex/Gemini/etc., or fall back to a
   timeout/heuristic). For agents exposing a structured channel (Codex app-server), prefer it over keystrokes.
4. Wire into the `agmux run <preset>` delegation path: spawn pane → wait ready → inject bootstrap prompt →
   confirm submit, then hand off to MCP comms for any further dialogue.
5. Test matrix: long (>16 KB) and multi-line prompts, slow-booting panes, rapid sequential injects.

## Deliverable

A `tmux-inject` module + design note documenting each gotcha and why naive `send-keys` is insufficient.
Keep injection scoped to spawn/bootstrap per the foundation's hard line; do not build it into a steering loop.
