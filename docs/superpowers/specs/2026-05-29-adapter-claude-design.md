# agmux — Claude Code Adapter Design

**Date:** 2026-05-29
**Status:** Design (spec). Per-provider challenge for **Claude Code**, the first concrete adapter on the Phase-2 framework.
**Builds on:** [`2026-05-29-adapters-framework-design.md`](2026-05-29-adapters-framework-design.md) (the agent-agnostic abstraction) and the framework implementation ([`../plans/2026-05-29-adapter-framework-phase2.md`](../plans/2026-05-29-adapter-framework-phase2.md), landed) — the `Adapter` interface, manifest vocabulary, `agmux emit`, per-target ledger, conformance harness, and registry seam already exist.

This doc fills in the framework's deliberately-open per-provider seams for Claude Code (framework §9): **source set**, **capability descriptors**, **isolation mode + mechanism**, **`dedup_key` scheme**, **`resumePlan` shape**, install mechanics, and known pitfalls. It commits to a design; the implementation session verifies the flagged runtime assumptions against the live tool and captures fixtures.

---

## 1. Ground truth (verified against Claude Code 2.1.156 on this machine)

The official docs are thin on runtime integration; these were confirmed by direct inspection of the live environment and transcripts.

- **Native session id is free.** `CLAUDE_CODE_SESSION_ID` is exported into the session env, **and** every hook receives `session_id` on stdin. It is **stable across `--resume`**. (A fork — `--fork-session` / `/branch` — mints a new id; not our concern.)
- **Config-dir isolation is real and in use.** `CLAUDE_CONFIG_DIR` relocates the entire config root (`settings.json`, `enabledPlugins`, `extraKnownMarketplaces`, `plugins/cache`, `plugins/data`, `projects/` transcripts). This is exactly the framework's `config-dir` isolation mode.
- **Hooks cover the lifecycle.** Confirmed events with the common stdin contract `{ session_id, transcript_path, cwd, hook_event_name, permission_mode }` (event-specific fields added): `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`, `PreToolUse`/`PostToolUse`, `PermissionRequest`. `transcript_path` is present on `SessionStart`/`Stop`/`SessionEnd`.
- **Hook I/O is safe for `emit`.** Exit 0 + empty stdout = allow/no-op; only exit 2 blocks. `agmux emit` already guarantees silent-stdout + always-exit-0, so it never perturbs Claude. Hooks accept `async: true` and an absolute or `$PATH` command; a plugin's `bin/` is added to PATH for its hooks; `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` are available.
- **Usage lives only in the transcript.** No usage hook, no OTEL needed. `<configDir>/projects/<slug>/<session_id>.jsonl`; each `assistant` record carries `.message.usage` as a **per-turn delta**: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `model`. Each transcript record has a stable `uuid`.
- **Official plugin management = the `/plugin` slash command**, drivable headlessly via `claude -p "/plugin …"`. There is **no standalone `claude plugin` CLI**. A marketplace may be a **local filesystem path** (`.claude-plugin/marketplace.json`, `source: local`). Install state is written under `CLAUDE_CONFIG_DIR`.

---

## 2. Decision: official plugin, never direct config edits

`install()` does **not** hand-edit `settings.json`. agmux ships a **static, in-repo local marketplace** exposing one plugin (`agmux`); install/uninstall/enable/status are driven through Claude's official `/plugin` commands, scoped to the target config dir. Direct file reads are allowed only for read-only `status()` fallback (§6); writes go exclusively through the official surface.

### 2.1 The shipped artifacts (static, provider-owned)

Co-located with the adapter module, committed to the repo, identical for every target:

```
packages/adapters/src/adapters/claude/marketplace/
  .claude-plugin/
    marketplace.json          # name:"agmux"; one plugin entry, source:"local", path:"./plugins/agmux"
  plugins/agmux/
    .claude-plugin/plugin.json # name:"agmux", version = adapterVersion
    hooks/hooks.json           # SessionStart / UserPromptSubmit / Stop / Notification / PostToolUse → emit
    bin/agmux-emit             # shim: exec "${AGMUX_BIN:-agmux}" emit "$@"
```

The plugin is **never mutated per-target** — the only per-target state is the enable flag inside each config dir, owned by Claude. Hooks reach the agmux binary via the `bin/` shim (`${AGMUX_BIN:-agmux} emit …`); `AGMUX_BIN`, `AGMUX_SESSION_ID`, `AGMUX_HUB_URL` are injected by the wrapper into the Claude process and inherited by the hook. (`AGMUX_BIN` injection is a small, additive wrapper concern noted in §8.)

### 2.2 install / uninstall / status (official commands, config-dir-scoped)

`resolvedConfigDir = ctx.profileEnv.CLAUDE_CONFIG_DIR ?? <default ~/.claude>`. Each command runs with `CLAUDE_CONFIG_DIR=resolvedConfigDir` in the child env.

- **`install(ctx)`** (synchronous; spawns Claude headlessly):
  1. `claude -p "/plugin marketplace add <abs marketplace dir>"` (idempotent).
  2. `claude -p "/plugin install agmux@agmux"` (installs + enables).
  Returns `InstallRecord { agentKind:"claude", profile, adapterVersion, isolationMode:"config-dir", capabilities, artifacts }`, where `artifacts` records `{ kind:"config-key", path:<configDir>/settings.json, detail:"plugin agmux@agmux", restore:null }` and the marketplace registration — enough for exact reversal.
- **`uninstall(ctx, record)`**: `claude -p "/plugin uninstall agmux@agmux"` (and `/plugin marketplace remove agmux` if no other agmux plugin remains), config-dir-scoped.
- **`status(ctx)`**: `claude -p "/plugin list --json"`, parse for `agmux@agmux` enabled. `runtimeGate: "hook-trust"` (plugin trust may gate activation, §7). Read-only fallback if the JSON surface is unavailable: stat `enabledPlugins["agmux@agmux"]` in the config dir's `settings.json` (read only).

---

## 3. Source set (`sources(ctx)`)

Two event-triggered sources (framework §2.0); no continuous sources in v1.

```
[
  { type: "hook-command",     activation: "event-triggered",
    points: ["session.linked","turn.started","turn.ended","input.required","tool.used","prompt.sent"] },
  { type: "transcript-delta", activation: "event-triggered",
    points: ["usage.reported"] },
]
```

### 3.1 Hook → manifest point wiring (in `hooks/hooks.json`)

| Hook event | matcher | `agmux emit` invocation | Manifest point |
|---|---|---|---|
| `SessionStart` | `startup\|resume` | `--source=hook-command --point=session.linked` | `session.linked` |
| `SessionStart` | `startup\|resume` | `--attach` | `session.adapter_attached` |
| `UserPromptSubmit` | — | `--source=hook-command --point=turn.started` | `turn.started` |
| `UserPromptSubmit` | — | `--source=hook-command --point=prompt.sent` *(optional)* | `prompt.sent` |
| `Stop` | — | `--source=hook-command --point=turn.ended` | `turn.ended` |
| `Stop` | — | `--source=transcript-delta --point=usage.reported --cursor-file=<…>` | `usage.reported` |
| `Notification` | — | `--source=hook-command --point=input.required` | `input.required` |
| `PostToolUse` | `*` | `--source=hook-command --point=tool.used` *(optional)* | `tool.used` |

All emit hooks are `async: true` (never delay Claude). `input.received` is **not** emitted separately — the next `UserPromptSubmit` (`turn.started`→`running`) is the de-facto "input received" transition; the projection guards make the missing event a no-op. Raw provider stdin is piped through; `emit` runs `normalize()` client-side.

---

## 4. Capability descriptors (`capabilities(ctx)`)

Identical across targets (capabilities don't vary by Claude profile). Finest-grain, honest about partial coverage (framework §6.2):

```
{
  "session.linked": { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "turn.started":   { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "turn.ended":     { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "input.required": { fulfil: "partial", source: "hook-command",     liveness: "live",
                      runtimeGate: "none" },   // Notification is coarse (permission AND idle)
  "usage.reported": { fulfil: "yes",     source: "transcript-delta", liveness: "backfilled" },
  "tool.used":      { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "prompt.sent":    { fulfil: "yes",     source: "hook-command",     liveness: "live" }
}
```

`input.received` is intentionally absent (fulfilled implicitly, never emitted) — conformance requires no source for an unlisted/`"no"` point. The whole map is gated at runtime by plugin trust; `status().runtimeGate` carries that, the descriptors stay capability-shaped.

---

## 5. Normalization, usage, and dedup (`normalize(input)`)

`emit` calls `normalize({ point, source, raw: <hook stdin JSON>, cursor, target })`.

- **`session.linked`**: `payload.native_session_id = raw.session_id` (Claude's id; the envelope's canonical `session_id` is stamped separately from `AGMUX_SESSION_ID`). No dedup needed.
- **`turn.started` / `turn.ended`**: empty/minimal payloads (`turn.ended` may carry `raw.reason` if present). State transitions; no dedup (idempotent under the projection's guards).
- **`input.required`**: `{ kind: "permission" }` when the Notification indicates a permission prompt, else `{ kind: "prompt" }`. Partial fidelity accepted.
- **`prompt.sent`** *(optional)*: `{ chars: raw.prompt?.length ?? null, redacted: true }` — never the prompt text.
- **`tool.used`** *(optional)*: `{ tool: raw.tool_name, ok: true }` (PostToolUse fires on success).
- **`usage.reported` (transcript-delta)** — the one stateful source:
  1. Open `raw.transcript_path`; seek to `cursor` (byte offset, `0` if absent).
  2. For each new line of `type === "assistant"` with `.message.usage`, emit one canonical event:
     ```
     payload = {
       cumulative: false, source: "transcript-delta", model: rec.message.model,
       input_tokens, output_tokens,
       cache_read_tokens:  usage.cache_read_input_tokens,
       cache_write_tokens: usage.cache_creation_input_tokens,
       // reasoning_output_tokens, total_tokens, cost_usd, rate_limit → null (Claude exposes none)
       turn_id: rec.message.id ?? null, as_of: rec.timestamp ?? null
     }
     dedup_key = `claude:transcript-delta:${native_session_id}:${rec.uuid}`
     ```
  3. Return `{ events, cursor: <new byte offset> }`. `emit` persists the cursor to `<stateDir>/cursors/<session_id>.claude`.

  Deltas accumulate in `session_usage` (framework §5.2). `rec.uuid` makes re-reads (duplicated Stop, resume re-scan) no-ops via the store's `dedup_key` index. Multiple assistant messages in one turn → multiple deltas, all distinct, summed correctly.

---

## 6. Isolation & install target

- **`isolationMode: "config-dir"`** — clean isolation by construction. A profile resolves to its own `CLAUDE_CONFIG_DIR`; the bare `claude` target uses the default. Installing into one config dir leaves every other profile and the bare target untouched. No `env-gated` runtime gating (that was Codex's problem, not Claude's).
- **Target resolution:** the adapter derives `resolvedConfigDir` from `ctx.profileEnv.CLAUDE_CONFIG_DIR`. For this to isolate per profile, the agmux profile that launches Claude must set `CLAUDE_CONFIG_DIR` in its `env` (a config convention, documented for users; not an agmux code change).

---

## 7. Pitfalls / validation risks (impl session must verify, not assume)

1. **Plugin trust gate.** Headless `claude -p "/plugin install"` may require trust acceptance before hooks activate. Verify the non-interactive trust path (e.g. `--allowedTools`, scope flags, or a settings trust pre-seed *via the official surface*). Surface unresolved trust as `status().runtimeGate = "hook-trust"`.
2. **Underdocumented `/plugin` flags.** `--json`, `--scope`, `--bare`, and headless `/plugin` behavior are inferred. Verify each; if `--json` is absent, use the read-only `settings.json` `enabledPlugins` check for `status()` (read, never write).
3. **Install is heavyweight.** Each `claude -p "/plugin …"` spawns a full Claude session (needs auth/network). Acceptable for an explicit, one-off `agmux adapter install`; document the latency.
4. **`Notification` coarseness.** Fires for permission prompts *and* idle waits; `input.required` may briefly over-report `waiting`. The projection's lost-sweep + next-turn transition keep status sane; capability is declared `partial`.
5. **Usage backfill timing.** Usage is read at `Stop`, slightly after the turn; a session killed mid-turn loses that turn's usage until a future read. The deferred continuous reconciliation (framework §1.4) is the eventual fix.
6. **Transcript path robustness.** Prefer `raw.transcript_path` from stdin; fall back to `<resolvedConfigDir>/projects/<slug>/<session_id>.jsonl` only if absent.
7. **Hook PATH / `AGMUX_BIN`.** Confirm the plugin `bin/` shim resolves the agmux binary in the hook's environment; rely on wrapper-injected `AGMUX_BIN` with a PATH fallback.

---

## 8. Touch-points beyond the adapter module

- **Wrapper:** inject `AGMUX_BIN` (absolute agmux path) alongside the existing `AGMUX_SESSION_ID`/`AGMUX_HUB_URL`/`AGMUX_PROFILE`, so plugin hooks can locate the binary. Small, additive to `buildChildEnv`; degrades to PATH lookup if unset.
- **Registry seam:** one line — `register(claudeAdapter)` in `packages/adapters/src/adapters/index.ts`.
- **No hub/store/protocol changes** — the framework already projects every event kind this adapter emits.

---

## 9. Deliverables for the implementation session

1. The static marketplace + plugin under `packages/adapters/src/adapters/claude/marketplace/` (manifest, `plugin.json`, `hooks/hooks.json`, `bin/agmux-emit`).
2. `packages/adapters/src/adapters/claude/index.ts` implementing `Adapter` per §2–§6.
3. **Captured fixtures** (real, committed) under `packages/adapters/tests/adapters/fixtures/claude/`: hook stdin JSON for `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `PostToolUse`; and transcript `assistant` record lines (with `.message.usage`).
4. `packages/adapters/tests/adapters/claude.test.ts`: `assertAdapterConformance(claudeAdapter, …)` green + fixture-driven `normalize()` tests (each point; usage delta math; dedup-key stability; cursor advance).
5. The `register(claudeAdapter)` line + the `AGMUX_BIN` wrapper injection.

Acceptance gate: conformance + fixture tests green; `bun run typecheck` and `bun test` clean; install/uninstall/status verified against a real Claude config dir (a scratch `CLAUDE_CONFIG_DIR`), with pitfalls §7 each either resolved or explicitly documented as a known limitation.

---

## 10. Open items left to the implementation session (intentionally)

- Exact headless trust-acceptance incantation (§7.1) and the precise `/plugin list` JSON shape (§7.2).
- Whether `prompt.sent` / `tool.used` ship in v1 or are held back (cheap, log-only; default: ship both).
- The Notification payload field that distinguishes permission vs idle (§5 `input.required.kind`).
