# agmux — PI Adapter Design

**Date:** 2026-06-18
**Status:** Design (spec). Per-provider challenge for **PI** (`pi` coding agent, [pi.dev](https://pi.dev/docs/latest/extensions)), the third concrete adapter on the Phase-2 framework.
**Builds on:** [`2026-05-29-adapters-framework-design.md`](2026-05-29-adapters-framework-design.md) (the agent-agnostic abstraction), [`2026-05-29-adapter-claude-design.md`](2026-05-29-adapter-claude-design.md) (filesystem-only install model), and [`2026-06-15-adapter-codex-design.md`](2026-06-15-adapter-codex-design.md) (stdin-borne identity, embedded payload). The `Adapter` interface, manifest vocabulary, `agmux emit`, per-target ledger, conformance harness, and registry seam already exist and are unchanged.

This doc fills the framework's deliberately-open per-provider seams for PI: **source set**, **capability descriptors**, **isolation mode + mechanism**, **`dedup_key` scheme**, **`resumePlan` shape**, install mechanics, and known pitfalls.

**Verification scope (decided):** implement against the PI docs + the local `~/.pi/agent` evidence, with full unit + conformance coverage and a stdin fixture. `pi` is not on PATH on this machine, so a **live wrapped smoke-test is deferred** as a follow-up (as the codex adapter was initially).

---

## 1. Ground truth (PI docs + local `~/.pi/agent`, v0.75.5)

- **Extensions are TypeScript modules, not shell hooks.** This is the defining divergence from Claude/Codex. PI auto-loads every `.ts` in `<configDir>/extensions/` (and `<configDir>/extensions/*/index.ts`) via jiti — no compilation, no marketplace, no settings.json edit. An extension exports a default factory `(pi: ExtensionAPI) => void` that registers event handlers with `pi.on(event, handler)`.
- **Config home** is `~/.pi/agent` (default), relocatable via **`PI_CODING_AGENT_DIR`**. Confirmed locally: `~/.pi/agent/{settings.json,sessions/,auth.json}`. This is exactly the framework's `config-dir` isolation mode — the PI analogue of `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. (`PI_CODING_AGENT_SESSION_DIR` / `--session-dir` relocate only sessions; not used here.)
- **Sessions** live at `<configDir>/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl` (confirmed: `2026-05-26T11-40-20-372Z_019e6415-f214-72d2-8352-afd93f03133c.jsonl`). Each file is a JSONL conversation tree (entries carry `id`/`parentId`). The **native session id = the UUID** after the `_` (PI's `--session <id>` accepts a partial UUID).
- **No native session-id env var.** Extensions obtain the session file via `ctx.sessionManager.getSessionFile()` (returns the path, or null for ephemeral/`-p` sessions). → identity comes from the emitted stdin payload, not env (codex pattern). `nativeIdFromEnv` omitted.
- **Resume:** `pi --session <path|id>` (partial UUID accepted). Also `-c`/`--continue` (most recent) and `-r`/`--resume` (interactive picker) — we use `--session <uuid>` for a deterministic, id-targeted resume. Parallel to `claude --resume <id>` / `codex resume <id>`.
- **The pi process IS the extension host.** Handlers run in-process, so `process.pid` is the agent pid directly — cleaner than codex's `$PPID` shell trick.
- **Event lifecycle** (the points we wire):
  - `session_start` — `{reason: "startup"|"reload"|"new"|"resume"|"fork", previousSessionFile?}`.
  - `input` — intercepts user text before expansion (source for `prompt.sent`).
  - `agent_start` / `agent_end` — **per user prompt** (the correct "turn" granularity; the finer `turn_start`/`turn_end` fire per LLM-response cycle and would over-count). `agent_end.messages` = messages produced this prompt.
  - `tool_result` — `{toolName, toolCallId, input, content, details, isError}`.
  - `message_end` — assistant message lifecycle; `event.message.usage` carries token figures (input/output/cache) and `event.message.model`. **Usage is delivered live, in-event** — no transcript tailing needed.
- **No native permission/idle event.** PI exposes no equivalent of Claude's `Notification` or Codex's `PermissionRequest`. `tool_call` can *block*, but there is no observable "agent is waiting on the user" signal. → `input.required` is **not fulfilled** (§4, decided).
- **Background-resource etiquette.** PI docs warn against starting long-lived resources from the factory and recommend deferring to `session_start` + cleaning up in `session_shutdown`. Our emits are short-lived fire-and-forget child processes (no persistent resource), so this is satisfied trivially; no `session_shutdown` handler is required.

---

## 2. Decision: filesystem-only extension drop (Claude-style)

`install()` writes a single embedded extension file to `<configDir>/extensions/agmux.ts`. PI auto-discovers it on the next session — **no settings.json mutation, no marketplace, no `pi` binary invocation**. Install/uninstall/status are pure filesystem operations owned by agmux and fully reversible (uninstall deletes the file). This mirrors Claude's skills-dir model rather than Codex's CLI-driven marketplace, because PI's auto-discovery makes the marketplace machinery unnecessary.

### 2.1 The shipped artifact (embedded as code)

Co-located with the adapter and embedded as a **string** (`extension-files.ts`), not an on-disk data file — so it works identically from source and from a `bun build --compile` binary (where `import.meta.dir` is virtual). At install time it is materialized to `<configDir>/extensions/agmux.ts`.

The extension:
- Defines `emit(point, payload)`: resolves the agmux binary (`process.env.AGMUX_BIN || "agmux"`), spawns `agmux emit --from=pi --source=hook-command --point=<point>` **detached**, writes a JSON payload to stdin, ends stdin, and `unref`s — fire-and-forget, never awaited, never blocks PI's event loop. The child inherits `process.env`, so `AGMUX_SESSION_ID`, `AGMUX_PROFILE`, `AGMUX_HUB_URL`, and `TMUX_PANE` (when wrapper-launched) flow through automatically.
- Resolves `session_id` once per emit from `ctx.sessionManager.getSessionFile()` → basename → strip `.jsonl` → take the UUID after the last `_`. Included in every payload (codex-style stdin identity).
- Carries `pid: process.pid` on the registration payload.
- Stamps a version marker line (`// agmux-pi-extension v<N>`) read back by `status()` for drift detection (the analogue of reading `plugin.json`'s `version`).
- Returns nothing from handlers (telemetry must never block or alter PI behavior).

### 2.2 Version / drift

`PLUGIN_VERSION` (the extension payload version) is embedded in the marker line. `status()` reads `<configDir>/extensions/agmux.ts`, presence ⇒ installed, marker-version ≠ current ⇒ `drift: true`. `runtimeGate: "hook-trust"` is retained as a conservative default until a live session proves PI auto-loads the extension ungated.

---

## 3. Sources & capability map

A single `hook-command` source (the extension *is* the command runner; functionally identical to a fired hook — reusing the existing `CapabilitySourceType` avoids a protocol change):

```
PI_SOURCES = [{
  type: "hook-command", activation: "event-triggered",
  points: ["session.registered","session.linked","turn.started","turn.ended",
           "tool.used","prompt.sent","usage.reported"],
}]
```

```
PI_CAPABILITIES = {
  "session.registered": { fulfil:"yes", source:"hook-command", liveness:"live" },
  "session.linked":     { fulfil:"yes", source:"hook-command", liveness:"live" },
  "turn.started":       { fulfil:"yes", source:"hook-command", liveness:"live" },
  "turn.ended":         { fulfil:"yes", source:"hook-command", liveness:"live" },
  "tool.used":          { fulfil:"yes", source:"hook-command", liveness:"live" },
  "prompt.sent":        { fulfil:"yes", source:"hook-command", liveness:"live" },
  "usage.reported":     { fulfil:"yes", source:"hook-command", liveness:"live" },
  // input.required: omitted — no native signal (decided gap). input.received:
  // omitted — fulfilled implicitly by the next turn.started (matches claude/codex).
}
```

Two differences from claude/codex worth noting:
- **`usage.reported` is `hook-command`/`live`**, not `transcript-delta`/`backfilled`. PI hands token usage to the extension in the `message_end` payload, so there is no transcript file to tail and no cursor file — a strictly simpler and lower-latency path.
- **`input.required` is absent** (no PII-free "waiting" signal). Consequence: PI sessions transition `running → idle` and never surface the `waiting` status. Honest per the partial-coverage model.

---

## 4. Event → manifest-point mapping (the extension's handlers)

| PI event | emits | payload notes |
|---|---|---|
| `session_start` | `session.registered`; then `--attach`; **plus** `session.linked` when `reason ∈ {resume, fork}` | `{native_session_id, agent_kind:"pi", pid: process.pid, cwd: ctx.cwd, tmux_pane: $TMUX_PANE, profile: $AGMUX_PROFILE, agent_version: null, parent: null}` |
| `input` | `prompt.sent` | `{chars: <text length>, redacted: true}` |
| `agent_start` | `turn.started` | `{}` |
| `tool_result` | `tool.used` | `{tool: event.toolName ?? "unknown", ok: !event.isError}` |
| `message_end` | `usage.reported` | from `event.message.usage` (all fields nullable), `model: event.message.model`; `cumulative:false`, `source:"hook-command"`; `dedup_key = pi:hook-command:<nativeId>:<message.id>` |
| `agent_end` | `turn.ended` | `{reason: null}` → status idle |

`normalize()` (in `normalize.ts`) is the pure mapper from `{point, raw, env}` to `CanonicalEvent[]`, exactly parallel to `normalizeCodex`. It reads identity/pid/cwd from the stdin payload, never from PI internals. `usage.reported`'s figure mapping is defensive (every field guarded; unknown shapes degrade to nulls) since the exact `message.usage` shape is confirmed only at live-verification time.

### 4.1 `message.usage` shape (provisional)

Mapped defensively into `UsageReport`: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_output_tokens`, `total_tokens`, `model_context_window` — each read via optional chaining with a `null` fallback. The precise field names are captured as a fixture during live verification; the mapper tolerates absence so a shape mismatch degrades gracefully (usage row with nulls) rather than dropping the event or throwing.

---

## 5. Identity & resume

- **`nativeIdFromStdin(raw)`** → `raw.session_id` if a non-empty string, else `null` (verbatim codex pattern). Ambient (`pi` launched directly) sessions self-register under their own UUID; wrapper-launched sessions additionally carry the `AGMUX_SESSION_ID` claim for the bridge. `nativeIdFromEnv` omitted.
- **No nesting guard.** Like codex, PI exports no native id into the env, so there is nothing to cross-check; nested runs self-register under their own UUID (framework §5.3).
- **`resumePlan`:** native id present ⇒ `{resumable:true, argv:[command, "--session", nativeSessionId, ...args], cwd, env, nativeSessionId}`; absent ⇒ `{resumable:false}` (caller relaunches fresh).

---

## 6. Package layout

`packages/adapters/src/adapters/pi/` — mirrors `codex/` file-for-file:

- `index.ts` — assemble `piAdapter` (`agentKind:"pi"`, `nativeIdFromStdin`).
- `caps.ts` — `PI_SOURCES`, `PI_CAPABILITIES` (§3).
- `install.ts` — `resolveConfigDir` (override → `PI_CODING_AGENT_DIR` → `~/.pi/agent`), `extensionsDir`, file-drop `piInstall`/`piUninstall`/`piStatus`, `ADAPTER_VERSION`.
- `extension-files.ts` — `PLUGIN_VERSION`, the embedded `agmux.ts` source string, `EXTENSION_FILES` list (§2.1).
- `normalize.ts` — `normalizePi` (§4).
- `resume.ts` — `piResumePlan` (§5).

### 6.1 Framework wiring (one-liners)

- `packages/protocol/src/session.ts`: `AgentKind = "claude" | "codex" | "pi"`.
- `packages/adapters/src/adapters/index.ts`: `registry.register(piAdapter)`.
- `packages/wrapper/src/profile.ts`: `asAgentKind` accepts `"pi"` (and its error message).
- `packages/cli/src/parse-run.ts`: `parseKind`, the `RunPlan` union, and the basename heuristic (`pi` → `pi`) accept `"pi"`.

---

## 7. Tests

- **Conformance** — reuse `assertAdapterConformance` with a PI harness (identity, sources↔caps coverage, install round-trip, resumePlan shape). The install round-trip uses a temp `PI_CODING_AGENT_DIR`.
- **`pi-normalize` / `pi.test`** — drive `normalizePi` per point against a `tests/adapters/fixtures/pi/hook-stdin.sample.json` reference payload (session_id, cwd, prompt, tool_name, message.usage). Assert event kinds, payload fields, and the usage `dedup_key`.
- **install** — `piInstall` writes `agmux.ts`; `piStatus` reports installed + version; `piUninstall` removes it and `piStatus` reports not-installed (drives the conformance round-trip too).
- **registry wiring** — `createDefaultRegistry().lookup("pi")` resolves the adapter.

---

## 8. Known pitfalls / flagged for live verification

1. **`message.usage` field names** — mapped defensively; exact shape captured as a fixture once a live `pi` run is available (§4.1).
2. **`input`-event payload shape for prompt length** — assumed to carry the user text; if PI names it differently, `prompt.sent.chars` degrades to `null` (log-only point, no projection impact).
3. **Auto-discovery ungated?** — assumed PI loads `<configDir>/extensions/agmux.ts` without a per-extension trust prompt. `runtimeGate:"hook-trust"` retained until proven otherwise.
4. **`getSessionFile()` null for `-p`/ephemeral** — such sessions emit no native id; with no wrapper claim they are correctly dropped by `agmux emit` (no false registration).
5. **Detached-spawn stdin race** — the child must finish reading stdin before exiting; the extension writes-then-ends stdin synchronously before `unref`. Verify no truncation under load during the live smoke-test.

---

## 9. Out of scope (v1)

`input.required` / `waiting` status (no native signal), subagent/parent linkage (PI `/fork` tree relationships), `before_provider_request` request mutation, custom tools/commands, and cost-in-USD derivation. All additive later behind the same manifest vocabulary.
