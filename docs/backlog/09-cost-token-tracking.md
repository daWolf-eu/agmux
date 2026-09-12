# Pitch 09 — Token/cost capture & the dual-tracking gotcha

**Source:** omnigent · **Target package(s):** `@agmux/insights`, `@agmux/adapters` · **agmux concern:** usage analytics & (future) budgets

---

## Handoff context (read first)

agmux records per-session events and `insights` does "analytics/queries over the event log" (foundation §6,
§12). Token usage and cost are among the most valuable analytics signals, and a future budget/cap feature
would depend on them. This finding covers how to capture usage from heterogeneous harnesses **and a sharp
correctness trap** omnigent hit. Read [`../agmux-foundation.md`](../agmux-foundation.md) §6, §12 (`insights`).

This is a **design pitch / spike**. Reference codebase: `https://github.com/omnigent-ai/omnigent` (grep; lines drift).

## What omnigent does

- **Capture per harness.** SDK harnesses get exact `usage` (input/output/cache tokens) on each turn
  (`TurnComplete`), fed to `runtime/telemetry.py:338` (`record_llm_usage`, emitted as MLflow/OTel spans).
  Codex-native gets cumulative `thread/tokenUsage/updated` notifications over the app-server. Claude-native has
  no clean usage feed — it **scrapes the `/cost` statusLine** into `context.json`.
- **The dual-tracking gotcha** (`claude_native_forwarder.py:1390`, `_forward_session_cost`). Claude's
  statusLine cost **lags real spend**, especially with sub-agents. So omnigent keeps **two** numbers: a
  *display* cost (the statusLine value, shown verbatim) and a *policy/budget* cost = `max(statusLine,
  transcript-derived-estimate)` including live sub-agent spend. Budgets gate on the conservative number; the UI
  shows the official one. This is non-obvious and load-bearing — naive single-source cost under-counts and a
  budget cap would fire too late.

## Why it matters for agmux

- Usage/cost per `session_id`, `agent_kind`, and `profile` is exactly the grouping agmux already makes
  first-class (§10) — `insights` can answer "spend by profile", "tokens by agent" essentially for free once
  the events exist.
- The capture method is heterogeneous, which is agmux's whole problem domain: SDK/Codex give structured
  numbers; Claude-native needs statusLine scraping via an adapter (composes with Pitch 01). Document the
  per-agent fidelity so consumers know which numbers are exact vs estimated.
- The dual-tracking insight is a *gift*: if agmux ever ships spend caps over a wrapped CLI, knowing the
  reported cost trails reality (and to gate on `max(reported, estimate)`) prevents a real bug.

## Plan outline

1. Define usage/cost event shapes in `protocol` (tokens in/out/cache, cost, source-fidelity flag
   `exact|estimated`), additive & versioned (§6).
2. Per-agent capture: SDK/Codex structured usage where available; a Claude-native adapter that reads the
   `/cost` statusLine (Pitch 01 hook path). Record fidelity per event.
3. Persist as events; let `insights` aggregate by `session_id`/`agent_kind`/`profile`/time.
4. Document the dual-tracking rule as guidance for any future budget feature: display the reported value, gate
   on `max(reported, estimate)`, include sub-agent spend.
5. Prototype: capture usage for one SDK and one Claude-native session; show an `insights` rollup by profile.

## Deliverable

A usage/cost design doc (event shapes + per-agent capture matrix + fidelity flags + the dual-tracking
guidance) and an `insights` rollup spike. Capture only — agmux is not adopting omnigent's MLflow tracing
backend or its server-side policy engine; local events + `insights` queries are the kernel.
