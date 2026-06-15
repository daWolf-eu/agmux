# agmux — Codex Adapter Design

**Date:** 2026-06-15
**Status:** Design (spec). Per-provider challenge for **Codex** (OpenAI Codex CLI), the second concrete adapter on the Phase-2 framework.
**Builds on:** [`2026-05-29-adapters-framework-design.md`](2026-05-29-adapters-framework-design.md) (the agent-agnostic abstraction) and [`2026-05-29-adapter-claude-design.md`](2026-05-29-adapter-claude-design.md) (the first concrete adapter, which this one parallels). The `Adapter` interface, manifest vocabulary, `agmux emit`, per-target ledger, conformance harness, and registry seam already exist and are unchanged.

This doc fills in the framework's deliberately-open per-provider seams for Codex (framework §9): **source set**, **capability descriptors**, **isolation mode + mechanism**, **`dedup_key` scheme**, **`resumePlan` shape**, install mechanics, and known pitfalls. It commits to a design; the implementation session verifies the flagged runtime assumptions against the live tool and captures fixtures.

**Relationship to the framework's §9.1 "Codex challenge":** those notes were provisional, recorded from an *early* Codex state ("no usage hook", "native session id is not a hook payload field"). They are now **superseded by ground truth** (§1): Codex's hook system has matured to near-parity with Claude's. Where §9.1 and §1 disagree, §1 wins.

---

## 1. Ground truth (verified against Codex CLI 0.135.0 on this machine)

- **Hooks are `stable` and enabled by default.** `codex features list` → `hooks  stable  true`. The lifecycle mirrors Claude's: `SessionStart` (with `source: startup|resume|clear|compact`), `UserPromptSubmit`, `Stop`, `PermissionRequest`, `PostToolUse` (plus Codex-only `PreToolUse`, `Subagent*`, `Pre/PostCompact`, not used here). The `plugin_hooks` feature flag shows `removed` — it is a stale internal flag, **not** the current plugin-hooks capability; plugins bundle hooks (§4).
- **Hook stdin carries identity for free.** Every hook payload includes `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`; turn-scoped hooks add `turn_id`. So `session.registered`/`session.linked` come straight from the hook — **not** transcript-only (this is the key change vs §9.1).
- **No native session-id env var.** Codex does **not** export a `CODEX_SESSION_ID` (or equivalent) into the session/hook environment; the id is only on hook stdin and in the rollout file. → `nativeIdFromEnv` is omitted (§5.3).
- **Native session id** = the UUID in `session_meta.payload.id` (first line of the rollout file) = the UUID in the rollout filename. Stable across `codex resume`.
- **Resume:** `codex resume <SESSION_ID>` — a subcommand taking the UUID (verified via `--help`: `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`). Parallel to `claude --resume <id>`.
- **Usage lives in the rollout file** (no usage hook). Path: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. `token_count` records carry richer data than Claude:
  ```json
  {"type":"token_count","info":{
    "total_token_usage":{"input_tokens":25797,"cached_input_tokens":12544,"output_tokens":651,"reasoning_output_tokens":164,"total_tokens":26448},
    "last_token_usage":{"input_tokens":15029,"cached_input_tokens":10624,"output_tokens":381,"reasoning_output_tokens":82,"total_tokens":15410},
    "model_context_window":258400},
   "rate_limits":{"limit_id":"codex","primary":{"used_percent":6.0,"window_minutes":10080,"resets_at":1780600072}}}
  ```
  `last_token_usage` = per-turn delta; `total_token_usage` = session-to-date. (Exact record envelope — top-level vs nested in an `event_msg` payload — is captured as a fixture in the impl session.)
- **Plugins are first-class and CLI-managed.** `codex plugin marketplace add|list|upgrade|remove`, `codex plugin add|list|remove`. `codex plugin list` is fast, local, **needs no auth/model**, and prints `PLUGIN  STATUS  VERSION  PATH` per plugin (STATUS = `installed` / `not installed`). Marketplaces may be **local filesystem paths**. Hook trust still applies (`/hooks` review of non-managed hooks) → `runtimeGate: "hook-trust"`.
- **`CODEX_HOME`** relocates the Codex config/state root (default `~/.codex`), including `sessions/`, `config.toml`, and `plugins/cache/`. This is exactly the framework's `config-dir` isolation mode — the Codex analogue of `CLAUDE_CONFIG_DIR`.

---

## 2. Decision: official plugin via local marketplace

`install()` does **not** hand-edit `hooks.json` or `config.toml`. agmux ships a **static, embedded plugin behind a local marketplace**; install/add/remove/status are driven through Codex's official `codex plugin` commands, scoped to the target `CODEX_HOME`. **No published package or network is involved** — the plugin ships inside the agmux binary and installs from a materialized local dir; the only externality is the `codex` binary on PATH. This mirrors Claude's documented marketplace fallback flow (claude-design §11 note 1). The skills-dir-style filesystem-only install Claude ultimately adopted has no documented Codex equivalent for hooks, so the marketplace flow is the committed baseline; a filesystem-only shortcut is an impl-session optimization to probe (§7), not assumed.

### 2.1 The shipped artifacts (static, embedded as code)

Co-located with the adapter module and embedded as **code** (`plugin-files.ts`), not on-disk data files — so the adapter works identically from source and from a `bun build --compile` binary (where `import.meta.dir` is virtual). At install time the payload is materialized to a stable agmux-owned dir.

```
<stateDir>/codex/marketplace/            # materialized at install
  .agents/plugins/marketplace.json       # name:"agmux"; one plugin, source local "./plugins/agmux"
  plugins/agmux/
    .codex-plugin/plugin.json            # name:"agmux", version = PLUGIN_VERSION
    hooks/hooks.json                      # SessionStart / UserPromptSubmit / Stop / PermissionRequest / PostToolUse → emit
    bin/agmux-emit                        # shim: exec "${AGMUX_BIN:-agmux}" emit "$@"
```

The plugin is **never mutated per-target** — per-target state is the marketplace registration + enable flag in the target's `config.toml`, owned by Codex. Hooks reach the agmux binary via `${AGMUX_BIN:-agmux} emit …`; `AGMUX_BIN`, `AGMUX_SESSION_ID`, `AGMUX_HUB_URL`, `AGMUX_PROFILE` are injected by the wrapper into the Codex process and inherited by the hook. Plugin hooks additionally receive `PLUGIN_ROOT`/`PLUGIN_DATA` (and `CLAUDE_PLUGIN_ROOT` legacy aliases) from Codex.

### 2.2 install / uninstall / status (official commands, CODEX_HOME-scoped)

`resolvedConfigDir = ctx.configDirOverride ?? ctx.profileEnv.CODEX_HOME ?? <default ~/.codex>`. Each command runs with `CODEX_HOME=resolvedConfigDir` in the child env.

- **`install(ctx)`**: materialize the embedded payload to `<stateDir>/codex/marketplace/` (idempotent refresh); then `codex plugin marketplace add <abs marketplace dir>` followed by `codex plugin add agmux@agmux`. Returns `InstallRecord { agentKind:"codex", profile, adapterVersion, isolationMode:"config-dir", capabilities, artifacts }`, where `artifacts` record the marketplace registration and plugin enable as `config-key` entries (path = `<resolvedConfigDir>/config.toml`, `restore` = prior value or null) — enough for exact reversal.
- **`uninstall(ctx, record)`**: `codex plugin remove agmux@agmux` (and `codex plugin marketplace remove agmux` if no other agmux plugin remains), `CODEX_HOME`-scoped.
- **`status(ctx)`**: `codex plugin list` (CODEX_HOME-scoped), parse the `agmux@agmux` row for `STATUS == installed`; read its `VERSION` for drift vs `PLUGIN_VERSION`. `runtimeGate: "hook-trust"` (trust may gate hook activation at session start, §7).

---

## 3. Source set (`sources(ctx)`)

Two event-triggered sources (framework §2.0); no continuous sources in v1. Identical to Claude.

```
[
  { type: "hook-command",     activation: "event-triggered",
    points: ["session.registered","session.linked","turn.started","turn.ended","input.required","tool.used","prompt.sent"] },
  { type: "transcript-delta", activation: "event-triggered",
    points: ["usage.reported"] },
]
```

### 3.1 Hook → manifest point wiring (in `hooks/hooks.json`)

| Codex hook | matcher | `agmux emit` invocation | Manifest point |
|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | `--source=hook-command --point=session.registered` (with `AGMUX_AGENT_PID=$PPID`) | `session.registered` |
| `SessionStart` | `startup\|resume\|clear\|compact` | `--attach` | `session.adapter_attached` |
| `UserPromptSubmit` | — | `--source=hook-command --point=turn.started` | `turn.started` |
| `UserPromptSubmit` | — | `--source=hook-command --point=prompt.sent` | `prompt.sent` |
| `Stop` | — | `--source=hook-command --point=turn.ended` | `turn.ended` |
| `Stop` | — | `--source=transcript-delta --point=usage.reported --cursor-file=<…>` | `usage.reported` |
| `PermissionRequest` | — | `--source=hook-command --point=input.required` | `input.required` |
| `PostToolUse` | `*` | `--source=hook-command --point=tool.used` | `tool.used` |

All emit hooks are `async: true` (never delay Codex). `input.received` is not emitted separately (the next `UserPromptSubmit`/`turn.started` is the de-facto transition; the projection guards make the missing event a no-op). Raw provider stdin is piped through; `emit` runs `normalize()` client-side and writes nothing to stdout (framework §4.2 — Codex may parse hook stdout as protocol).

> If Codex's `SessionStart` hook does not accept a `matcher` on `source`, register it without a matcher and rely on the stdin `source` field; the manifest point stays `session.registered`. (Impl-session check, §7.)

---

## 4. Capability descriptors (`capabilities(ctx)`)

Identical across targets (capabilities don't vary by Codex profile). Finest-grain, honest about partial coverage (framework §6.2):

```
{
  "session.registered": { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "session.linked":     { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "turn.started":       { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "turn.ended":         { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "input.required":     { fulfil: "partial", source: "hook-command",     liveness: "live" },  // PermissionRequest = permission only; no idle/prompt hook
  "usage.reported":     { fulfil: "yes",     source: "transcript-delta", liveness: "backfilled" },
  "tool.used":          { fulfil: "yes",     source: "hook-command",     liveness: "live" },
  "prompt.sent":        { fulfil: "yes",     source: "hook-command",     liveness: "live" }
}
```

`input.required` is `partial` for the mirror-image reason to Claude's: Claude's `Notification` is *coarse* (permission AND idle); Codex's `PermissionRequest` is *narrow* (permission only, no idle/prompt-waiting hook). Either way the projection's lost-sweep + next-turn transition keep status sane. `input.received` is intentionally absent (fulfilled implicitly, never emitted). The whole map is gated at runtime by hook trust; `status().runtimeGate` carries that.

---

## 5. Normalization, usage, and dedup (`normalize(input)`)

`emit` calls `normalize({ point, source, raw: <hook stdin JSON>, cursor, target, env })`. Control flow mirrors `normalizeClaude`.

### 5.1 Hook-command points

- **`session.registered`**: `payload = { native_session_id: raw.session_id, agent_kind:"codex", pid: <AGMUX_AGENT_PID|null>, cwd: raw.cwd ?? env.PWD ?? null, tmux_pane: env.TMUX_PANE ?? null, profile: env.AGMUX_PROFILE ?? null, agent_version: <see §5.3>, parent: null, tmux_session: null, tmux_window: null }`. No-op if `raw.session_id` absent.
- **`session.linked`**: `{ native_session_id: raw.session_id }`. No-op if absent.
- **`turn.started`**: `{}`. **`turn.ended`**: `{ reason: raw.reason ?? null }`.
- **`input.required`**: `{ kind: "permission" }` (Codex's `PermissionRequest` is always a permission/approval request; the exact stdin field, if any sub-kind exists, is an impl-session check, §7).
- **`prompt.sent`**: `{ chars: raw.prompt?.length ?? null, redacted: true }` — never the prompt text.
- **`tool.used`**: `{ tool: raw.tool_name ?? "unknown", ok: true }` (PostToolUse fires after completion; `raw.tool_response` may later refine `ok`).

### 5.2 `usage.reported` (transcript-delta) — the one stateful source

Same cursor mechanics as Claude (byte offset over `raw.transcript_path`, whole-lines-only, advance cursor). Per new `token_count` record:

```
payload = {
  cumulative: false, source: "transcript-delta",
  model: <from session_meta / turn_context, else null>,
  input_tokens:  info.last_token_usage.input_tokens,
  output_tokens: info.last_token_usage.output_tokens,
  cache_read_tokens:  info.last_token_usage.cached_input_tokens,
  cache_write_tokens: null,                                   // Codex has no write-cache figure
  reasoning_output_tokens: info.last_token_usage.reasoning_output_tokens,
  total_tokens:            info.last_token_usage.total_tokens,
  model_context_window:    info.model_context_window,
  rate_limit:              <from rate_limits.primary, if present>,
  turn_id: raw.turn_id ?? null, as_of: rec.timestamp ?? null
}
dedup_key = `codex:transcript-delta:${native_session_id}:${recordByteOffset}`
```

Use `last_token_usage` (the per-turn delta, `cumulative:false`) so `session_usage` accumulates correctly via the framework's delta path. Codex fills **more** of the §3.2 superset than Claude (`reasoning_output_tokens`, `total_tokens`, `model_context_window`, `rate_limit`). `cache_write_tokens` is null (no Codex equivalent).

**Dedup key:** Codex `token_count` records have **no stable per-record `uuid`** (unlike Claude's transcript records). Use the record's **byte offset within the rollout** (monotonic, stable across re-reads) as the dedup discriminator: `codex:transcript-delta:<sid>:<offset>`. The cursor already prevents forward re-reads; the offset key makes a resume re-scan idempotent. (Validate against a real resume re-scan in the impl session, §7.)

### 5.3 Identity differences from Claude

- **`nativeIdFromEnv` is omitted.** Codex exports no native-id env var, so the adapter cannot stamp native identity before a hook fires; `emit` falls back to canonical (`AGMUX_SESSION_ID`) identity. `session.registered`/`session.linked` still carry `native_session_id` from hook stdin, so the hub's native→canonical resolution works once the first hook fires.
- **No env-vs-stdin nesting guard.** Claude's guard drops events when `CLAUDE_CODE_SESSION_ID` (env) ≠ `session_id` (stdin) under a wrapper claim. Codex has no env id to cross-check, so this guard is not implemented; nested Codex runs self-register under their own stdin `session_id` (acceptable — same as Claude's direct/native-exec path, which also passes through).
- **`agent_version`:** if Codex exposes a version env var to hooks (e.g. `CODEX_VERSION`), use it; else null. The rollout `session_meta.payload.cli_version` is `"0.135.0"` but is not on the hook env. (Impl-session check, §7.)

---

## 6. Isolation & install target

- **`isolationMode: "config-dir"`** — clean isolation by construction, exactly like Claude. A profile resolves to its own `CODEX_HOME`; the bare `codex` target uses the default `~/.codex`. Installing into one `CODEX_HOME` leaves every other profile and the bare target untouched. No `env-gated` runtime gating needed (the framework's §9.1 env-gated path was for `codex -p` layering over a *shared* `$CODEX_HOME`; agmux avoids that by giving each profile its own `CODEX_HOME`).
- **Target resolution:** the adapter derives `resolvedConfigDir` from `ctx.configDirOverride ?? ctx.profileEnv.CODEX_HOME ?? ~/.codex`. For per-profile isolation, the agmux profile that launches Codex must set `CODEX_HOME` in its `env` (a config convention, documented for users; not an agmux code change) — the direct analogue of Claude's `CLAUDE_CONFIG_DIR` convention.

---

## 7. Pitfalls / validation risks (impl session must verify, not assume)

1. **`codex plugin add` argument form.** Verify the exact ref syntax (`agmux@agmux` vs `agmux` vs a path) and that `marketplace add <local-dir>` accepts an absolute path and snapshots it (so the materialized dir can persist under `<stateDir>`). Confirm both run non-interactively without auth/model.
2. **`codex plugin list` parse shape.** Columns are `PLUGIN STATUS VERSION PATH`; confirm a stable parse (or a `--json` flag if one exists). `isInstalled` = STATUS `installed`.
3. **Hook trust gate.** Non-managed hooks require `/hooks` review before activation. Verify whether a wrapped session activates them, and the non-interactive trust path; surface unresolved trust as `status().runtimeGate = "hook-trust"`.
4. **`token_count` record envelope.** Confirm whether `token_count` is a top-level rollout record or nested under an `event_msg` payload, and the exact field path for `model` and `rate_limit`. Capture real fixture lines.
5. **`SessionStart` matcher support.** Confirm `matcher: "startup|resume|clear|compact"` is honored; if not, drop the matcher (§3.1 note).
6. **`PermissionRequest` payload.** Confirm field(s) for `input.required.kind`; whether any non-permission sub-kind exists.
7. **Transcript path robustness.** Prefer `raw.transcript_path`; fall back to `<resolvedConfigDir>/sessions/<…>/rollout-*-<session_id>.jsonl` only if absent.
8. **Hook PATH / `AGMUX_BIN`.** Confirm the plugin `bin/` shim (or baked `${AGMUX_BIN:-agmux}`) resolves the agmux binary in the hook environment; rely on wrapper-injected `AGMUX_BIN` with a PATH fallback.
9. **Usage backfill timing.** Usage is read at `Stop`, slightly after the turn; a session killed mid-turn loses that turn's usage until a future read (same as Claude; deferred continuous reconciliation is the eventual fix).

---

## 8. Touch-points beyond the adapter module

- **Registry seam:** one line — `register(codexAdapter)` in `packages/adapters/src/adapters/index.ts`.
- **No protocol change:** `AgentKind` already includes `"codex"`; the CLI (`adapter-cmd.ts`) already accepts `--kind codex` and dispatches dynamically via `registry.lookup`.
- **No hub/store changes** — the framework already projects every event kind this adapter emits, and the usage projection already handles the superset fields.
- **Wrapper:** none beyond what Claude already required (`AGMUX_BIN`/`AGMUX_PROFILE` injection already landed). Confirm the `run`-path `--kind` validation (`bin/agmux.ts`, `parse-run.ts`) accepts `codex` for direct-exec — verify and patch if it still hardcodes `claude`.

---

## 9. Deliverables for the implementation session

1. The embedded marketplace + plugin payload in `packages/adapters/src/adapters/codex/plugin-files.ts` (marketplace.json, `.codex-plugin/plugin.json`, `hooks/hooks.json`, `bin/agmux-emit`).
2. `packages/adapters/src/adapters/codex/{index,caps,normalize,resume,install}.ts` implementing `Adapter` per §2–§6.
3. **Captured fixtures** (real, committed) under `packages/adapters/tests/adapters/fixtures/codex/`: hook stdin JSON for `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, `PostToolUse`; and rollout `session_meta` + `token_count` record lines.
4. `packages/adapters/tests/adapters/codex.test.ts`: `assertAdapterConformance(codexAdapter, …)` green + fixture-driven `normalize()` tests (each point; usage delta math; dedup-key stability; cursor advance).
5. The `register(codexAdapter)` line + the `registry-wiring.test.ts` `toContain("codex")` assertion; `run`-path `--kind codex` validation confirmed/patched.

**Acceptance gate:** conformance + fixture tests green; `bun run typecheck` and `bun test` clean; install/uninstall/status verified against a scratch `CODEX_HOME`, with §7 pitfalls each resolved or explicitly documented as a known limitation.

---

## 10. Divergences from the Claude adapter (summary)

| Concern | Claude | Codex |
|---|---|---|
| Install | filesystem-only skills-dir plugin (`rm -rf` uninstall) | local marketplace + `codex plugin add` (CLI-driven) |
| Config dir | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` |
| Native id in env | `CLAUDE_CODE_SESSION_ID` → `nativeIdFromEnv` + nesting guard | none → `nativeIdFromEnv` omitted, no nesting guard |
| `input.required` | `partial` (Notification coarse: permission+idle) | `partial` (PermissionRequest narrow: permission only) |
| Usage source | transcript `assistant.message.usage`, per-record `uuid` dedup | rollout `token_count.last_token_usage`, byte-offset dedup; fills more of §3.2 |
| Resume | `claude --resume <id>` | `codex resume <id>` |

Everything else — source/capability shape, hook→point wiring, normalize control flow, `isolationMode: "config-dir"`, `runtimeGate: "hook-trust"`, projection behavior — is identical.
