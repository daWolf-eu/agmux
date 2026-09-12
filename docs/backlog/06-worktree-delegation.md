# Pitch 06 — Git-worktree isolation + diff-as-message review

**Source:** omnigent (Polly example) · **Target package(s):** `@agmux/cli` (orchestration verbs) · **agmux concern:** parallel delegation

---

## Handoff context (read first)

agmux supports agent-to-agent delegation: "a workflow can spawn a new tmux pane running `agmux run <preset>`
(a different agent), inject a prompt, and the new session auto-announces with a `parent_session_id` link"
(foundation §7). When delegated agents *edit code in parallel*, they need isolation and a way to ship results
back without trampling each other. This finding supplies that. Read
[`../agmux-foundation.md`](../agmux-foundation.md) §7, §12 (`cli` owns orchestration verbs).

This is a **design pitch / spike**. Reference codebase: `https://github.com/omnigent-ai/omnigent` (grep; lines drift).

## What omnigent does

omnigent's example orchestrator **Polly** (a tech lead that writes no code) delegates coding to parallel
sub-agents, each isolated in its own **git worktree**, then routes only the **diff** to a reviewer from a
*different vendor*:

- `create_worktree()` (`omnigent/host/git_worktree.py:275`) runs `git worktree add -b <branch> <path>`, always
  resolving to the **main** repo root so worktrees are *siblings, never nested* (`_main_work_tree:140`), with
  branch-name validation (`:48`). Each child's `workspace` becomes its terminal `cwd`.
- Review is **diff-as-message**: Polly extracts `git diff main...HEAD` (or `gh pr diff`) and dispatches the
  *text* to a reviewer that gets **no filesystem access** — total isolation, no shared-FS coordination.
- Cleanup: `git worktree remove --force` + `git branch -D` (`:355`).
- Cross-vendor review (code by Claude → reviewed by Codex) is a product principle, free because delegation is
  harness-agnostic.

`git_worktree.py` is small, self-contained, and nearly dependency-free — close to lift-and-port.

## Why it matters for agmux

- Directly realizes agmux's parallel-delegation vision (§7) with the isolation primitive it currently lacks.
  Each worktree-backed child is a normal agmux session with a `parent_session_id` and (now) a workspace.
- "diff-as-message" rides agmux's existing rails: the diff is just a payload in a `message.sent` event /
  comms message (§8), so the delegation + review graph is queryable by `insights` for free.
- Validates the multi-agent premise: heterogeneous agents become an asset (cross-vendor review) when the
  substrate normalizes them — which is agmux's whole thesis.

## Plan outline

1. Port a `worktree` helper into `cli`: create (sibling resolution + branch validation), list, remove. TS
   shell-outs to `git`. Mirror omnigent's main-root resolution to avoid nested worktrees.
2. Extend the delegation verb: `spawn child → create worktree → set as cwd → inject task` (composes with
   Pitch 02 injection and Pitch 07 delegation).
3. Add a `diff` extraction verb and wire the diff into a delegated review session as a message payload (no FS
   share) — leaning on `comms` (Pitch 03) where available.
4. Record worktree/branch as session attributes so `insights` can render the delegation+review lineage.
5. Lifecycle: clean up worktree+branch on session end; handle dirty/abandoned worktrees safely.

## Deliverable

A `worktree` module + an extended delegation flow design doc demonstrating: spawn N coding children in
sibling worktrees, collect diffs, dispatch each to a different-`agent_kind` reviewer. Keep results flowing as
events/messages, consistent with §8.
