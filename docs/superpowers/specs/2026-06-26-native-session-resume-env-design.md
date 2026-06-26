# native-session resume env — design

**Date:** 2026-06-26
**Branch:** `bugfix/dash-resume-lost-session`
**Status:** approved

## Problem

Resuming a **natively-launched** agent session from `agmux dash` (or `agmux
attach`) fails: `claude --resume <native_id>` runs without the config-affecting
env the original session had, so Claude looks in the default `~/.claude` config
dir, can't find the conversation, and dies with "No conversation found".

Concrete repro: the user launches Claude via an alias
`ccc='CLAUDE_CONFIG_DIR=~/.claude-chax claude'`. Transcripts live under
`~/.claude-chax/projects/…`. The session is hook-tracked (`origin=native`) but the
session row records **no env**. At relaunch, `CLAUDE_CONFIG_DIR` is gone.

### Why wrapper/profile sessions already work

`agmux run -p claude-work` launches through the wrapper, and the `session.started`
event records `env_overrides: profile.env`. For `claude-work` that is
`{ CLAUDE_CONFIG_DIR = "~/.claude-chax" }`. `buildRelaunchSpec` feeds
`session.env_overrides` into the adapter resume plan, so the relaunched
`claude --resume <id>` carries `CLAUDE_CONFIG_DIR`. Native sessions never populate
`env_overrides`, so they have nothing to restore.

### Why earlier "fixes" were wrong layer

- Forwarding the dash's full `process.env` to the relaunch tmux window
  (`relaunchEnv` → `spec.env`) cannot help: the dash's own env does not contain
  `CLAUDE_CONFIG_DIR` either (the alias sets it only inside the Claude process as a
  per-command assignment). **This change will be reverted.**
- A new tmux window inherits only the tmux **server** env (snapshot at server
  start) and runs the command directly (no login shell, no rc sourcing), so neither
  inheritance path supplies `CLAUDE_CONFIG_DIR`. The value must be *recorded on the
  session* and re-applied at relaunch.

## Background (current architecture)

- **Hook → emit → normalize** (`packages/cli/src/emit.ts:115`): the agent's hook
  runs `agmux emit`, which calls `adapter.normalize({ …, env: deps.env })`.
  `deps.env` is the hook process env, inherited from the provider — it **does**
  contain `CLAUDE_CONFIG_DIR`. So env capture is feasible client-side, at
  registration time.
- **`session.registered` payload** (`packages/adapters/src/adapters/claude/normalize.ts`):
  carries `native_session_id`, `agent_kind`, `pid`, `cwd`, `tmux_*`,
  `profile` (= `env.AGMUX_PROFILE ?? null`), `agent_version`, `parent`. **No env
  field today.**
- **Session row** (`packages/store/.../schema.ts`): has `env_json` (used by wrapper
  `env_overrides`) and a `profile` column.
- **Relaunch** (`packages/cli/src/relaunch.ts`): native-resume branch
  (`adapter && native_session_id && !neverConversed`) builds the resume argv via
  `adapter.resumePlan` using `session.env_overrides` for env. The
  `if (!resumed && session.profile)` profile-reload branch is **bypassed** once a
  native resume is chosen — so a stored `profile` contributes nothing on resume
  today.
- **Adapter interface** (`packages/adapters/src/core/types.ts`): `sources()`,
  `capabilities()`, `normalize()`, `resumePlan()`, `nativeIdFromEnv()`, etc. No
  declaration of relaunch-critical env keys.

## Goal

Native sessions resume with the same config-affecting env they ran with, via two
complementary mechanisms, **without ever bulk-reading the environment**.

## Mechanism A — adapter-declared env capture (automatic, default)

1. **Declare keys per adapter.** Add `relaunchEnvKeys: string[]` to the `Adapter`
   interface. Claude → `["CLAUDE_CONFIG_DIR"]`. Codex/pi → `[]` (extend later).
2. **Capture only declared keys.** A shared helper iterates **over the declared
   key list** and pulls present values from `input.env`. It never enumerates the
   environment. Result is a `Record<string,string>` of just those keys that are set.
3. **Carry on the event.** Add `env_overrides?: Record<string,string>` to the
   `session.registered` event payload; the claude `session.registered` case sets it
   from the capture helper.
4. **Persist.** The store projection writes registered `env_overrides` into the
   existing `env_json` column (same field wrapper sessions use).
5. **Reuse existing resume.** Because `buildRelaunchSpec` already applies
   `session.env_overrides`, native rows now behave like wrapper rows. No user action.

### Security constraint (hard requirement)

Capture is **strictly allowlisted to `relaunchEnvKeys`**. There is no wildcard,
prefix match, or "copy the whole env" path anywhere in the capture flow. Declared
keys are config *pointers* (e.g. `CLAUDE_CONFIG_DIR`), not credentials. A regression
test asserts that an undeclared variable present in `input.env` (e.g. a fake
`SECRET_TOKEN`) is **not** captured.

## Mechanism B — `AGMUX_PROFILE` explicit override

1. User sets `AGMUX_PROFILE=claude-work` in the native launch (e.g. the `ccc`
   alias). The hook already records it as `session.profile` — **no capture-side code
   change**.
2. `buildRelaunchSpec`: when `session.profile` is set, load that profile from the
   agmux config and merge its `env` into the resume env. This must apply on the
   **native-resume branch** (currently bypassed), not only the fresh-relaunch branch.
3. **Env only.** On a native resume, `AGMUX_PROFILE` contributes **env only** —
   command/args/cwd still come from the adapter resume plan (we want
   `claude --resume <id>`, not the profile's bare `claude`).

### Sub-decisions

- **Reuse `AGMUX_PROFILE`** (not a new `AGMUX_AGENT_PROFILE`): already captured and
  plumbed. Verify during impl that setting it on a native launch does not trigger
  unwanted "env-gated" adapter auto-install behavior (Claude hooks are installed
  globally already; expected to be a no-op, but confirm).
- **`buildRelaunchSpec` reads config**: it must load the named profile's `env`.
  `loadProfile` is exported from the wrapper package; reuse it rather than
  re-parsing config.

## Precedence & data flow

```
captured env (A: relaunchEnvKeys ∩ hook env)   ── lowest
profile env (B: AGMUX_PROFILE → profile.env)   ── overrides A
resume-plan env (adapter.resumePlan)           ── final merge target
```

Merge with profile winning over captured. The merged env rides into the relaunch
via `AGMUX_INLINE_PROFILE` (already forwarded through the dash allowlist) and is
applied by the wrapper's `buildChildEnv`.

## Dash path change

Revert the full-env forwarding in `resumeIntoSession` back to the
`relaunchEnv` allowlist (restore `RELAUNCH_ENV_KEYS`, `relaunchEnv`, and the
allowlist test). With the env now stored on the session and carried in
`AGMUX_INLINE_PROFILE`, the allowlist is sufficient.

## Wrapper re-exec path (folded in)

The outer wrapper, when launched **outside** tmux (`agmux run …` from a bare
shell), creates a tmux window and re-execs itself inside it
(`packages/wrapper/src/index.ts:71-83`), forwarding only the same 6-key allowlist
via tmux `-e`. An ad-hoc `agmux run claude` whose `CLAUDE_CONFIG_DIR` was set
ambiently in the shell (not via a profile) loses it across the window boundary —
the same class of bug on the initial-launch path.

**Fix:** forward the outer wrapper's **full `process.env`** (filtered of
`undefined`) to the inner window instead of the 6-key allowlist.

**Why full-env here, but allowlist + stored-env for the dash?** They are different
situations, not a contradiction:

- The outer wrapper **is the launch** and already holds the exact ambient env the
  user intends for the agent; only the tmux-window boundary severs it. Re-execing
  with the full env is normal process-continuation semantics.
- The dash **relaunches a dead session** whose env it never had, so it must restore
  from env recorded on the session row (mechanisms A/B) — full-env forwarding there
  is useless.

**Secrets note:** this is transient tmux *window* env (process-env propagation to a
child), not persistent storage. The allowlist-only capture constraint applies to
what we **store on the session row** (the DB), which is unchanged here. So full-env
re-exec does not widen the storage surface.

## Components touched

- `packages/adapters/src/core/types.ts` — add `relaunchEnvKeys` to `Adapter`.
- `packages/adapters/src/adapters/{claude,codex,pi}/index.ts` — declare keys
  (claude `["CLAUDE_CONFIG_DIR"]`, others `[]`).
- `packages/adapters/src/adapters/claude/normalize.ts` — set `env_overrides` on
  `session.registered` via the capture helper.
- capture helper — shared location (e.g. `core/`), allowlist-only.
- `packages/protocol/src/…` — `env_overrides?` on the `session.registered` payload.
- `packages/store/…` — projection writes registered `env_overrides` to `env_json`.
- `packages/cli/src/relaunch.ts` — load + merge profile env on the native-resume
  branch; precedence captured < profile.
- `packages/cli/src/dash-actions.ts` — revert full-env to allowlist.
- `packages/wrapper/src/index.ts` — re-exec forwards full `process.env` instead of
  the 6-key allowlist.
- `packages/adapters/src/core/conformance.ts` — assert `relaunchEnvKeys` is a
  string array.

## Testing

- **Capture helper:** declared keys present → captured; declared keys absent →
  omitted; **undeclared key present → dropped** (secrets guard).
- **Conformance:** every adapter declares `relaunchEnvKeys: string[]`.
- **Store:** a `session.registered` event with `env_overrides` persists to
  `env_json` and reads back on the session row.
- **Relaunch:**
  - native session with `env_overrides={CLAUDE_CONFIG_DIR}` → resume argv env
    includes it.
  - native session with `session.profile` set → profile env merged and **wins**
    over captured; command/args remain `claude --resume <id>` (env-only).
  - no profile, no captured env → unchanged fresh-relaunch behavior.
- **Dash:** restore the allowlist test (`relaunchEnv` filters to the agmux keys).
- **Wrapper re-exec:** the inner window receives the full outer env (a non-allowlist
  var such as `CLAUDE_CONFIG_DIR` set ambiently is forwarded, not dropped).

## Out of scope

- Mechanism-1 "profile matcher" (auto-matching native sessions to a profile by
  command/cwd heuristics) — rejected as fragile.
