# Reliable bootstrap prompt injection into tmux CLIs — design

Date: 2026-06-19
Status: Approved design, pre-implementation
Pitch: [`docs/backlog/02-tmux-prompt-injection.md`](../../backlog/02-tmux-prompt-injection.md)
Reference impl: omnigent `omnigent/claude_native_bridge.py` (`inject_user_message` + helpers)

## 1. Summary

A small TypeScript module in `@agmux/cli` that reliably delivers a **bootstrap
prompt** into a freshly-spawned agent CLI running in a tmux pane, plus a
`--prompt`/`--prompt-file` flag on `agmux run` that uses it. After `agmux run`
places a pane (`--new-pane`/`--new-window`/`--new-session`), it waits for the
agent's TUI to render, pastes the prompt via a tmux buffer (not `send-keys`),
and verifies the submit landed.

This ports omnigent's hard-won injection mechanics — buffer-paste, readiness
gating, payload sanitization, and verified submit — onto agmux's existing
injectable tmux-exec seams.

Scope is **bootstrap/one-shot delegation only**, per the foundation's hard line
(§8 / §14.9): injection is reserved for spawn/bootstrap; ongoing dialogue goes
through structured MCP comms, never keystrokes.

## 2. Goals / non-goals

**Goals**
- `agmux run --new-window -p claude-work --prompt "do X"` spawns the agent and
  reliably submits "do X" as its first message.
- Correctly handle prompts that are long (>16 KB), multi-line, or contain
  control characters — the cases where naive `send-keys` flakes.
- Work across `agent_kind`s: glyph-gated where we know the prompt glyph
  (`claude`), timeout-gated fallback elsewhere (`codex`, `pi`, unknown).
- Inject failure never fails the spawned session or changes the exit code.
- Unit-testable with a fake tmux exec; no live tmux required in CI.

**Non-goals (this pitch)**
- No `agmux delegate` verb; no `parent_session_id` lineage wiring.
- No soft-interrupt (Escape) or hard-stop verbs. Hard-stop already exists
  (`killCmd` → SIGTERM); soft-interrupt is a steering primitive that belongs to
  a future comms/steering effort, not bootstrap.
- No structured-channel injection (e.g. Codex `app-server` JSON-RPC). Left as a
  documented seam: prefer a structured channel over keystrokes *where one
  exists*, in a later effort.
- No event emitted for the injected prompt (see §7).

## 3. Why naive `send-keys` is insufficient (the IP being ported)

These are the production bugs omnigent hit; porting saves agmux from
rediscovering them:

- **argv length cap** — tmux caps a single client→server command at ~16 KB; a
  large prompt sent as `send-keys` argv fails with "command too long".
- **multi-line submits once per newline** — `send-keys` with a multi-line string
  submits each line as a separate message (`anthropics/claude-code#52126`).
- **dropped first message** — typing into a still-booting TUI silently drops the
  input.
- **silently-failed submit** — a fire-and-forget `Enter` is coalesced with the
  paste burst under load and the draft sits unsent.
- **escape-sequence corruption** — a stray control byte (e.g. ESC) inside a
  bracketed paste prematurely closes the paste and corrupts the draft.
- **trailing-backslash line-continuation** — a prompt ending in `\` makes the
  submit `Enter` read as a continuation; the message never sends.

## 4. Architecture

A new module `packages/cli/src/tmux-inject.ts` in the CLI package (foundation
§12: orchestration verbs live in `@agmux/cli`). It depends only on tmux
shell-outs through injectable exec seams, mirroring the existing pattern in
`packages/cli/src/tmux-place.ts:114` and `packages/cli/src/dash-preview.ts:12`.

### Delivery model (chosen: CLI-orchestrated post-spawn inject)

`agmux run` already spawns the pane detached and gets `coords.pane` back. The
same `run` process then runs the inject sequence synchronously against that
pane. Errors surface directly; nothing is backgrounded.

Rejected alternatives:
- **Self-injection via env handoff** (`AGMUX_BOOTSTRAP_PROMPT` seeded by an
  adapter/SessionStart hook or a structured channel). Only works for
  adapter-equipped agents and discards the very tmux IP this pitch captures.
  Kept as the documented preferred path *where a structured channel exists*.
- **Detached background injector** — adds lifecycle complexity and loses error
  reporting for a sub-second operation.

### Public surface

```ts
export type AgentKind = "claude" | "codex" | "pi"; // from @agmux/protocol

// Glyph that signals "input box rendered". null = no known glyph for this kind.
export const READINESS_GLYPHS: Record<AgentKind, string | null> = {
  claude: "❯",
  codex: null,  // TBD — confirm against a live codex TUI before setting
  pi: null,     // TBD
};

export interface InjectOpts {
  pane: string;                  // tmux pane id, e.g. "%3" (from spawn coords)
  text: string;                  // the bootstrap prompt
  agentKind?: AgentKind;         // drives glyph lookup; undefined → null glyph
  timeoutMs?: number;            // overall readiness cap (default 30_000)
  exec?: TmuxExec;               // injected; defaults to real Bun.spawn(["tmux", …])
  capture?: TmuxText;            // injected; defaults to capture-pane runner
}

export type InjectOutcome =
  | "submitted"             // draft seen and confirmed cleared after Enter
  | "submitted-unverified"  // Enter sent but submit could not be confirmed
  | "timeout-ready"         // readiness gate timed out; pasted+submitted blind
  | "failed";               // a tmux command errored

export interface InjectResult { outcome: InjectOutcome; detail?: string; }

export async function injectBootstrap(opts: InjectOpts): Promise<InjectResult>;
```

Internal primitives, exported for direct unit testing: `sanitizePayload`,
`waitForReady`, `pasteViaBuffer`, `computeNeedle`, `verifiedSubmit`.

Exec seams reuse the existing types:
```ts
type TmuxExec = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>;
type TmuxText = (args: string[]) => Promise<string>; // capture-pane → stdout
```
Defaults shell out via `Bun.spawn(["tmux", ...args])`, matching
`tmux-place.ts:116`. agmux uses the ambient tmux server, so **no `-S socket`**
flag (omnigent needs it because it runs its own server; we hold the pane id on
the user's server).

## 5. The injection sequence

`injectBootstrap` runs these steps in order:

### 5.1 Readiness gate — `waitForReady`
Poll `capture-pane -p -t <pane>` every **150 ms** up to `timeoutMs` (default
30 s):
- **Known glyph** (`claude`): ready when the glyph appears in the **last 5
  non-empty lines** of the capture (`PROMPT_SCAN_TAIL_LINES = 5`). Tail-scan,
  not whole-pane (avoids matching the glyph echoed in scrollback) and not
  last-line-only (the glyph sits inside a bordered box above footer text). No
  output-stability check — matches omnigent; the glyph persists while the agent
  is busy, so its presence means "input box mounted." Proceed immediately.
- **Null glyph** (`codex`/`pi`/unknown): no glyph to key on, so use an
  **output-stability** heuristic — ready when the capture is unchanged for 2
  consecutive polls — bounded by `timeoutMs`.
- **Timeout**: return readiness state `timeout-ready` and proceed anyway (paste
  + blind submit). Bootstrap must never block forever. This is agmux's
  deliberate generalization of omnigent, which raises on a missing glyph;
  agmux must support adapter-less / non-claude kinds.

### 5.2 Pre-clear input
`send-keys -t <pane> C-a` then `send-keys -t <pane> C-k` — Home + kill-to-end,
clearing any pre-populated text so the prompt can't concatenate with stale
content. Cheap insurance; harmless on an empty prompt.

### 5.3 Payload sanitization — `sanitizePayload(text)`
Transform the prompt to bytes safe for a bracketed paste (port of
`_paste_payload_bytes`):
1. Normalize `\r\n` and `\r` → `\n`.
2. Append a single trailing `\n` to the (normalized) content — absorbs a
   trailing `\` so it can't escape the submit Enter.
3. Per character: `\n` → `0x0D` (CR); `\t` → `0x09` (kept); any other byte
   `< 0x20` → **dropped** (a stray ESC would close the bracketed paste); all
   else → UTF-8 bytes.

### 5.4 Buffer paste — `pasteViaBuffer(pane, bytes)`
Two tmux calls:
1. `tmux load-buffer -b agmux-paste -` with the sanitized bytes piped via
   **stdin** (no temp file → no cleanup race; `Bun.spawn` supports stdin).
   Named buffer avoids clobbering the user's buffers.
2. `tmux paste-buffer -t <pane> -b agmux-paste -p -d` — `-p` = bracketed paste
   (multi-line lands as one chunk, dodging the per-newline submit bug); `-d` =
   delete the buffer after paste.

This does **not** send Enter — paste and submit are separate.

### 5.5 Verified submit — `verifiedSubmit(pane, text)`
Port of omnigent's submit verification:
1. `needle = computeNeedle(text)` — first non-empty line, truncated at the first
   control char, stripped, capped at **24 chars** (`DRAFT_NEEDLE_MAX_CHARS`).
2. Poll up to **5 s** for the draft to land: in the **last glyph-bearing line**
   of the capture, look at the text *after* the glyph and match the needle **or**
   the literal `"[Pasted text"` placeholder (Claude collapses long pastes into
   `[Pasted text +N lines]`, so the needle won't appear verbatim).
   - For null-glyph kinds (no glyph line), match the needle anywhere in the last
     `PROMPT_SCAN_TAIL_LINES`.
3. **0.1 s settle**, then `send-keys -t <pane> Enter`.
4. If the draft was **never** observed → blind submit, no retry → return
   `timeout-ready` if readiness also timed out, else `submitted-unverified`.
5. Else verify: poll up to **10 s**; success when the draft clears from the input
   box → `submitted`. Re-send `Enter` every **1 s** while it persists. If still
   present after 10 s → `submitted-unverified` (we did send Enter; we just
   couldn't confirm). Never throws.

### Tunable constants (one place, documented)
`POLL_INTERVAL_MS = 150`, `PROMPT_SCAN_TAIL_LINES = 5`, `DRAFT_NEEDLE_MAX_CHARS
= 24`, `PASTE_SETTLE_MS = 100`, `PASTE_COMMIT_TIMEOUT_MS = 5_000`,
`SUBMIT_VERIFY_TIMEOUT_MS = 10_000`, `SUBMIT_RETRY_INTERVAL_MS = 1_000`,
`READY_TIMEOUT_MS = 30_000`, `STABLE_POLLS = 2`.

## 6. `agmux run` wiring & CLI surface

- **Flags** (`packages/cli/src/parse-run.ts`): `--prompt <text>` and
  `--prompt-file <path>` (mutually exclusive; file is read and used as `text`).
  Parsed result gains `prompt?: string`.
- **Placement constraint**: `--prompt` requires a *placed* spawn
  (`--new-pane`/`--new-window`/`--new-session`). With `inherit` placement
  (`runInherit`, `stdio: "inherit"`, blocks on the child) there is no separate
  pane to inject into → parse error: `--prompt requires --new-pane,
  --new-window, or --new-session`.
- **Flow** (`packages/cli/src/run.ts`, `runWithPlacement`): after the existing
  `splitPane`/`newWindow`/`newSession` returns `coords`, if `opts.prompt` is set
  call `injectBootstrap({ pane: coords.pane, text, agentKind: <resolved kind> })`.
  The resolved `kind` already exists in `bin/agmux.ts` (inline names it; profile
  loads it) and is threaded into `RunOpts`.
- **Reporting**: keep the existing `agmux: spawned in <coords>` line, then append
  one line: `prompt injected` / `prompt injected (submit unconfirmed)` /
  `prompt inject timed out — pane may still be booting` / `prompt inject failed:
  <detail>`. Inject outcome **never** changes the exit code — the session is
  already spawned and recorded.

## 7. No event emitted for the injected prompt

The inject path emits **no agmux event** of its own. If the spawned agent has an
adapter, its native hook (`UserPromptSubmit` / `prompt.sent`) already records the
bootstrap text — agmux emitting its own would double-count. Adapter-less kinds
have no prompt event, consistent with the rest of the system. Injection is a
fire-action, not a recorded fact. (If delegation lineage is wanted later, that
is the `parent_session_id` path — explicitly out of scope here.)

## 8. Testing

**Unit (fake `exec`/`capture`, no live tmux — repo convention):**
- `sanitizePayload`: `\r\n`→single `\n`→`0x0D`; `\t` kept; ESC/other `<0x20`
  dropped; trailing `\` absorbed by appended newline; UTF-8 multibyte preserved.
- `waitForReady`: glyph found in last-5-non-empty-lines across a capture with
  borders+footer; glyph echoed only in scrollback (lines >5 from bottom) does
  NOT match; null-glyph stability path (changing → stable→ready); timeout →
  `timeout-ready`.
- `pasteViaBuffer`: emits `load-buffer -b agmux-paste -` with the sanitized
  bytes on stdin and `paste-buffer -t <pane> -b agmux-paste -p -d`.
- `computeNeedle`: first non-empty line, control-char truncation, ≤24 chars.
- `verifiedSubmit`: draft-seen→Enter→cleared = `submitted`; `[Pasted text`
  placeholder counts as draft-seen; draft never clears → re-sends Enter then
  `submitted-unverified`; draft never seen → blind submit, no retry.
- `injectBootstrap`: outcome plumbing; a failing tmux exec → `failed`, no throw.

**Parse:** `--prompt`, `--prompt-file`, mutual exclusion, `--prompt` + `inherit`
→ error.

**`run` wiring:** with a fake injector, `injectBootstrap` is called with the
spawned pane id only when `prompt` is set; inject failure leaves exit code 0.

**Manual smoke checklist (documented in the module's design note, not CI):** the
pitch's matrix — prompt >16 KB; multi-line prompt; prompt with a trailing `\`;
prompt containing an ESC byte; slow-booting pane; rapid sequential
`agmux run --prompt` into the same session — verified by hand against a live
claude pane.

## 9. File plan

**Create:**
- `packages/cli/src/tmux-inject.ts` — module per §4/§5.
- `packages/cli/tests/tmux-inject.test.ts` — unit tests per §8.

**Modify:**
- `packages/cli/src/parse-run.ts` — `--prompt`/`--prompt-file`, placement
  validation, `prompt?: string` on the parsed result.
- `packages/cli/tests/parse-run.test.ts` — new flag + error cases.
- `packages/cli/src/run.ts` — thread `prompt` through `RunOpts`; call
  `injectBootstrap` after placement; report outcome.
- `packages/cli/tests/run.test.ts` — wiring + exit-code-unaffected cases.
- `packages/cli/bin/agmux.ts` — pass parsed `prompt` into `runCmd`; usage text.

**Reference (read, do not modify):** `packages/cli/src/tmux-place.ts` (exec-seam
pattern, coords), `packages/cli/src/dash-preview.ts` (`capture-pane` runner),
omnigent `claude_native_bridge.py` (the ported mechanics).

## 10. Open items / future seams (not built here)
- Confirm `codex` / `pi` readiness glyphs against live TUIs; until then they use
  the timeout/stability fallback.
- Structured-channel injection (Codex `app-server`) preferred over keystrokes
  where available — future effort.
- `agmux delegate` verb + `parent_session_id` lineage — future effort; the
  inject module is the reusable primitive it would build on.
- Soft-interrupt / steering — belongs to the comms effort (`@agmux/comms`),
  delivered via MCP per foundation §8, not via injection.
