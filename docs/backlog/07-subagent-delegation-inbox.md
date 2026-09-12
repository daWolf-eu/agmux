# Pitch 07 — Async sub-agent delegation, inbox & blocked-child escalation

**Source:** omnigent (Polly) · **Target package(s):** `@agmux/cli`, `@agmux/comms` · **agmux concern:** orchestration lineage & collection

---

## Handoff context (read first)

agmux has `parent_session_id` lineage and a queryable delegation graph "from day one" (foundation §7), plus an
inter-agent comms model where messages are events and delivery is subscribe/MCP-pull (§8). This finding is the
*orchestration semantics* on top of those rails — how a parent dispatches children, collects their results,
and learns when one is stuck. Read [`../agmux-foundation.md`](../agmux-foundation.md) §7, §8.

This is a **design pitch / spike**. Reference codebase: `https://github.com/omnigent-ai/omnigent` (grep; lines drift).

## What omnigent does

omnigent's delegation is **session-based, not in-context** — a parent spawns a *child session* and steers it
through one merged tool, `sys_session_send` (`omnigent/tools/builtins/spawn.py:56`):

- **Spawn-or-continue.** Named mode `(agent, title)`: first call creates+starts the child; the *same pair*
  later **continues** it (child sees full history + new `args`). One verb covers both dispatch and re-steer.
- **Always async**, returns `{task_id, conversation_id, status}`. Parallel fan-out = multiple calls in one
  turn (Polly caps at 5).
- **Inbox collection.** Child runs autonomously; on completion the runner drops a structured result on the
  parent's **inbox** and posts a wake notice (`"… N result(s) waiting — call sys_read_inbox"`,
  `runner/app.py:3961`); parent drains via `sys_read_inbox` (`tools/builtins/async_inbox.py:240`). No busy-poll.
- **Blocked-child escalation.** `SubagentBlockNotifier` (`runtime/subagent_block_notifier.py:97`) watches for a
  child blocked on a human approval, waits a 120 s grace, then wakes the parent — and again when it clears.

## Why it matters for agmux

- agmux's comms already has `check_inbox`/`ask`/`reply` (§8, §12 `comms`) and lineage via `parent_session_id`.
  omnigent supplies the *protocol* over those primitives: async dispatch, the spawn-or-continue idiom, inbox
  hand-back, and a stuck-child signal — turning agmux's graph into a working orchestration loop.
- It honors agmux's hard line: collection is **pull via MCP inbox**, not pane injection (§14.9). Injection is
  used only for the initial spawn/bootstrap (Pitch 02).
- Every step is already an event in agmux's model (`message.sent`, completion, block notices) → the whole
  delegation+escalation history is queryable by `insights` for free.

## Plan outline

1. Define the agmux delegation verbs in `cli`: `delegate(agent_kind/profile, task, parent_session_id)` →
   spawn pane (Pitch 02) + optional worktree (Pitch 06) + register lineage; and a `continue`/re-steer verb
   keyed on a stable child handle (omnigent's spawn-or-continue idiom).
2. Model dispatch/result/wake as events; expose collection through the `comms` inbox MCP (`check_inbox`) so
   the parent pulls results at a turn boundary — no busy-poll.
3. Port the blocked-child concept: detect a child stalled on a human approval (via its adapter/hook events,
   Pitch 01), emit a `notification.raised` to the parent after a grace period, and a clear-notice on resume.
4. Bound fan-out (per-turn dispatch cap) and define child terminal-status handling + cancellation.
5. Prototype: parent delegates 2 children in parallel, collects both via inbox, and is notified when one
   blocks.

## Deliverable

A delegation/orchestration design doc mapping omnigent's `sys_session_send`/inbox/notifier semantics onto
agmux's event-log + comms-inbox model, plus a two-child fan-out spike. **Drop** omnigent's in-memory
Future-park registries and runner affinity — agmux expresses state as events and collects via the MCP inbox.
