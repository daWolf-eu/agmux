# Bootstrap tmux Prompt Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `packages/cli/src/tmux-inject.ts` module that reliably delivers a bootstrap prompt into a freshly-spawned agent's tmux pane, and wire it to a new `agmux run --prompt`/`--prompt-file` flag.

**Architecture:** `agmux run` already spawns the pane and gets its `pane` id back. After placement, the same process runs a deterministic inject sequence against that pane: wait for the TUI to render → pre-clear → sanitize the payload → paste via a tmux buffer (not `send-keys`) → verify the submit landed. All tmux access goes through injected exec/capture/sleep seams so the logic unit-tests with no live tmux. Inject failure never changes the spawn's exit code.

**Tech Stack:** TypeScript on Bun. `bun:test`. No new dependencies. Mirrors the injectable-exec pattern in `packages/cli/src/tmux-place.ts` and `packages/cli/src/dash-preview.ts`.

**Spec:** [`docs/superpowers/specs/2026-06-19-tmux-prompt-injection-design.md`](../superpowers/specs/2026-06-19-tmux-prompt-injection-design.md)

---

## File Structure

**Create:**
- `packages/cli/src/tmux-inject.ts` — the whole injection module: constants, exec/capture/sleep seams, pure predicates (`sanitizePayload`, `computeNeedle`, `glyphInTail`, `draftLanded`), polling primitives (`waitForReady`, `pasteViaBuffer`, `verifiedSubmit`), the `injectBootstrap` orchestrator, `READINESS_GLYPHS`, and `reportInject`.
- `packages/cli/tests/tmux-inject.test.ts` — unit tests for all of the above.

**Modify:**
- `packages/cli/src/parse-run.ts` — `--prompt`/`--prompt-file` parsing, mutual-exclusion + placement validation, `prompt?`/`promptFile?` on `ParsedRun`.
- `packages/cli/tests/parse-run.test.ts` — new flag + error cases.
- `packages/cli/src/run.ts` — `agentKind`/`prompt` on `RunOpts`; `runInjectStep` helper; call it after placement; print the report.
- `packages/cli/tests/run.test.ts` — `runInjectStep` behavior (called only when prompt set; never throws).
- `packages/cli/bin/agmux.ts` — resolve `--prompt-file` to text, pass `prompt` + `agentKind` into `runCmd`, update usage text.

**Reference (read, do not modify):** `packages/cli/src/tmux-place.ts` (exec-seam pattern, `PaneCoords`), `packages/cli/src/dash-preview.ts` (`capture-pane` runner), the spec above (the ported omnigent mechanics).

---

### Task 1: Payload sanitization & draft needle (pure functions)

These are the two byte-level helpers with no tmux dependency. Start here — they're the highest-value, most-testable IP.

**Files:**
- Create: `packages/cli/src/tmux-inject.ts`
- Test: `packages/cli/tests/tmux-inject.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/tests/tmux-inject.test.ts`:

```ts
import { test, expect } from "bun:test";
import { sanitizePayload, computeNeedle } from "../src/tmux-inject.ts";

// sanitizePayload returns the exact bytes to load into the tmux buffer.
// Compare via Array.from for readable failures.
const bytes = (s: string) => Array.from(sanitizePayload(s));

test("sanitizePayload converts \\n to CR (0x0D) and appends a trailing newline", () => {
  // "a\nb" → 'a', CR, 'b', and a trailing CR from the appended "\n"
  expect(bytes("a\nb")).toEqual([0x61, 0x0d, 0x62, 0x0d]);
});

test("sanitizePayload normalizes CRLF and CR to a single newline", () => {
  expect(bytes("a\r\nb")).toEqual([0x61, 0x0d, 0x62, 0x0d]);
  expect(bytes("a\rb")).toEqual([0x61, 0x0d, 0x62, 0x0d]);
});

test("sanitizePayload keeps tab but drops other control bytes (e.g. ESC)", () => {
  // "\t" kept as 0x09; ESC (0x1b) dropped so it can't close the bracketed paste
  expect(bytes("a\tb")).toEqual([0x61, 0x09, 0x62, 0x0d]);
  expect(bytes("a\x1bb")).toEqual([0x61, 0x62, 0x0d]);
});

test("sanitizePayload encodes multibyte UTF-8 printables", () => {
  // "é" is 0xC3 0xA9 in UTF-8, then the appended trailing CR
  expect(bytes("é")).toEqual([0xc3, 0xa9, 0x0d]);
});

test("sanitizePayload trailing backslash is absorbed by the appended newline", () => {
  // "x\\" → 'x', '\\', CR — the CR means the submit Enter is a fresh keypress,
  // not a line-continuation of the backslash.
  expect(bytes("x\\")).toEqual([0x78, 0x5c, 0x0d]);
});

test("computeNeedle takes the first non-empty line, stripped, truncated at first control char, max 24 chars", () => {
  expect(computeNeedle("  hello world  ")).toBe("hello world");
  expect(computeNeedle("\n\n  second line is used")).toBe("second line is used");
  expect(computeNeedle("before\tafter")).toBe("before"); // truncates at the tab
  expect(computeNeedle("x".repeat(40))).toBe("x".repeat(24));
  expect(computeNeedle("   \n   ")).toBe(""); // all whitespace → empty needle
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: FAIL — `Cannot find module '../src/tmux-inject.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/tmux-inject.ts`:

```ts
// Bootstrap prompt injection into a freshly-spawned agent's tmux pane.
// Ported from omnigent's claude_native_bridge.py (inject_user_message + helpers).
// Scope: spawn/bootstrap only (foundation §8/§14.9) — never a steering loop.
//
// All tmux access flows through injected exec/capture/sleep seams so the logic
// unit-tests with no live tmux, mirroring tmux-place.ts / dash-preview.ts.

import type { AgentKind } from "@agmux/protocol";

export const DRAFT_NEEDLE_MAX_CHARS = 24;

// Build the exact bytes to load into a tmux buffer for a bracketed paste.
//  - normalize CRLF/CR → \n, then append a trailing \n so a trailing "\" can't
//    escape the submit Enter (line-continuation bug)
//  - \n → 0x0D (CR): under bracketed paste the TUI keeps these as in-draft newlines
//  - \t → 0x09 (kept)
//  - any other byte < 0x20 dropped: a stray ESC would prematurely close the paste
//  - everything else → UTF-8 bytes
export function sanitizePayload(text: string): Uint8Array {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + "\n";
  const out: number[] = [];
  const enc = new TextEncoder();
  for (const ch of normalized) {
    if (ch === "\n") { out.push(0x0d); continue; }
    if (ch === "\t") { out.push(0x09); continue; }
    const code = ch.codePointAt(0)!;
    if (code < 0x20) continue;
    for (const b of enc.encode(ch)) out.push(b);
  }
  return Uint8Array.from(out);
}

// The distinctive substring we poll the pane for to confirm the draft landed:
// first non-empty line, truncated at the first control char, stripped, capped.
export function computeNeedle(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const rawLine of normalized.split("\n")) {
    let line = rawLine;
    for (let i = 0; i < line.length; i++) {
      if (line.charCodeAt(i) < 0x20) { line = line.slice(0, i); break; }
    }
    line = line.trim();
    if (line) return line.slice(0, DRAFT_NEEDLE_MAX_CHARS);
  }
  return "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tmux-inject.ts packages/cli/tests/tmux-inject.test.ts
git commit -m "cli: tmux-inject payload sanitization + draft needle"
```

---

### Task 2: Readiness & draft predicates (pure)

Pure capture-text predicates: is the prompt glyph rendered, and has the draft landed. Tail-scan (not whole-pane, not last-line-only) per the spec.

**Files:**
- Modify: `packages/cli/src/tmux-inject.ts`
- Test: `packages/cli/tests/tmux-inject.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/tmux-inject.test.ts`:

```ts
import { glyphInTail, draftLanded, PROMPT_SCAN_TAIL_LINES } from "../src/tmux-inject.ts";

const claudeBox = [
  "previous output line",
  "╭───────────────────────────╮",
  "│ ❯ do the thing            │",
  "╰───────────────────────────╯",
  "  ? for shortcuts      1.2k tokens",
].join("\n");

test("glyphInTail finds the glyph inside the bordered box above footer text", () => {
  expect(glyphInTail(claudeBox, "❯", PROMPT_SCAN_TAIL_LINES)).toBe(true);
});

test("glyphInTail ignores the glyph when it is only in scrollback (beyond the tail window)", () => {
  const lines = ["❯ old echoed prompt"];
  for (let i = 0; i < 10; i++) lines.push(`output ${i}`); // push the glyph >5 lines up
  expect(glyphInTail(lines.join("\n"), "❯", PROMPT_SCAN_TAIL_LINES)).toBe(false);
});

test("glyphInTail returns false when the glyph is absent", () => {
  expect(glyphInTail("just\nplain\noutput", "❯", PROMPT_SCAN_TAIL_LINES)).toBe(false);
});

test("draftLanded matches the needle in the text after the last glyph", () => {
  expect(draftLanded(claudeBox, "❯", "do the thing")).toBe(true);
});

test("draftLanded accepts the collapsed [Pasted text placeholder regardless of needle", () => {
  const collapsed = "│ ❯ [Pasted text +42 lines]   │";
  expect(draftLanded(collapsed, "❯", "needle never appears")).toBe(true);
});

test("draftLanded with no glyph (null-glyph kind) matches the needle anywhere in the tail", () => {
  // empty glyph string => fall back to tail substring match
  expect(draftLanded("codex prompt\n> do the thing", "", "do the thing")).toBe(true);
  expect(draftLanded("codex prompt\n> nothing here", "", "do the thing")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: FAIL — `glyphInTail`/`draftLanded`/`PROMPT_SCAN_TAIL_LINES` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/cli/src/tmux-inject.ts`:

```ts
export const PROMPT_SCAN_TAIL_LINES = 5;
const PASTED_PLACEHOLDER = "[Pasted text";

function tailNonEmptyLines(capture: string, n: number): string[] {
  const nonEmpty = capture.split("\n").filter((l) => l.trim().length > 0);
  return nonEmpty.slice(-n);
}

// The glyph signals "input box rendered". Scan the last N non-empty lines only:
// whole-pane would match the glyph echoed in scrollback; last-line-only misses it
// (the glyph sits in a bordered box above footer text).
export function glyphInTail(capture: string, glyph: string, tailLines: number): boolean {
  if (!glyph) return false;
  return tailNonEmptyLines(capture, tailLines).some((l) => l.includes(glyph));
}

// Has the draft landed in the input box?
//  - glyph kinds: inspect the text AFTER the last glyph-bearing line; accept the
//    needle OR the collapsed "[Pasted text +N lines]" placeholder
//  - null-glyph kinds (glyph === ""): match the needle anywhere in the tail
export function draftLanded(capture: string, glyph: string, needle: string): boolean {
  if (!glyph) {
    const tail = tailNonEmptyLines(capture, PROMPT_SCAN_TAIL_LINES).join("\n");
    return needle.length > 0 && tail.includes(needle);
  }
  const glyphLines = capture.split("\n").filter((l) => l.includes(glyph));
  if (glyphLines.length === 0) return false;
  const after = glyphLines[glyphLines.length - 1]!.split(glyph).pop() ?? "";
  if (after.includes(PASTED_PLACEHOLDER)) return true;
  return needle.length > 0 && after.includes(needle);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tmux-inject.ts packages/cli/tests/tmux-inject.test.ts
git commit -m "cli: tmux-inject readiness + draft predicates"
```

---

### Task 3: Exec/capture/sleep seams + buffer paste

The injectable tmux seams and the load-buffer/paste-buffer delivery. agmux uses the ambient tmux server, so no `-S socket` flag.

**Files:**
- Modify: `packages/cli/src/tmux-inject.ts`
- Test: `packages/cli/tests/tmux-inject.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/tmux-inject.test.ts`:

```ts
import { pasteViaBuffer, type TmuxExec } from "../src/tmux-inject.ts";

test("pasteViaBuffer loads the sanitized bytes via stdin and pastes with -p -d", async () => {
  const calls: { args: string[]; stdin?: Uint8Array }[] = [];
  const exec: TmuxExec = async (args, stdin) => {
    calls.push({ args, stdin });
    return { code: 0, stdout: "" };
  };
  await pasteViaBuffer("%3", sanitizePayload("hello"), exec);

  expect(calls).toHaveLength(2);
  // 1) load-buffer from stdin into a named buffer
  expect(calls[0]!.args).toEqual(["load-buffer", "-b", "agmux-paste", "-"]);
  expect(Array.from(calls[0]!.stdin!)).toEqual(Array.from(sanitizePayload("hello")));
  // 2) bracketed paste (-p) into the pane, deleting the buffer after (-d)
  expect(calls[1]!.args).toEqual(["paste-buffer", "-t", "%3", "-b", "agmux-paste", "-p", "-d"]);
});

test("pasteViaBuffer throws if a tmux command exits non-zero", async () => {
  const exec: TmuxExec = async () => ({ code: 1, stdout: "" });
  await expect(pasteViaBuffer("%3", sanitizePayload("x"), exec)).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: FAIL — `pasteViaBuffer`/`TmuxExec` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/cli/src/tmux-inject.ts`:

```ts
const PASTE_BUFFER_NAME = "agmux-paste";

// Injectable tmux seams. Defaults shell out via Bun.spawn(["tmux", ...]),
// matching tmux-place.ts:116. No `-S socket`: agmux uses the ambient server.
export type TmuxExec = (args: string[], stdin?: Uint8Array) => Promise<{ code: number; stdout: string }>;
export type TmuxCapture = (pane: string) => Promise<string>;
export type Sleep = (ms: number) => Promise<void>;

export const defaultExec: TmuxExec = async (args, stdin) => {
  const proc = Bun.spawn(["tmux", ...args], {
    stdin: stdin ? stdin : "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { code: proc.exitCode ?? 0, stdout };
};

export const defaultCapture: TmuxCapture = async (pane) => {
  const { stdout } = await defaultExec(["capture-pane", "-p", "-t", pane]);
  return stdout;
};

export const defaultSleep: Sleep = (ms) => Bun.sleep(ms);

async function run(exec: TmuxExec, args: string[], stdin?: Uint8Array): Promise<void> {
  const { code } = await exec(args, stdin);
  if (code !== 0) throw new Error(`tmux ${args[0]} exited ${code}`);
}

// Deliver text into the pane's input box via a tmux buffer (NOT send-keys):
//  - load-buffer dodges the ~16 KB argv cap (bytes arrive on stdin)
//  - paste-buffer -p uses bracketed paste so multi-line lands as one chunk
//    (dodges the per-newline submit bug, anthropics/claude-code#52126)
//  - -d deletes the named buffer afterward
export async function pasteViaBuffer(pane: string, bytes: Uint8Array, exec: TmuxExec): Promise<void> {
  await run(exec, ["load-buffer", "-b", PASTE_BUFFER_NAME, "-"], bytes);
  await run(exec, ["paste-buffer", "-t", pane, "-b", PASTE_BUFFER_NAME, "-p", "-d"]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tmux-inject.ts packages/cli/tests/tmux-inject.test.ts
git commit -m "cli: tmux-inject exec seams + buffer paste"
```

---

### Task 4: Readiness gate polling loop

`waitForReady` drives the predicates over polled captures, bounded by a fixed attempt count (timeout/interval) so tests are deterministic without a clock.

**Files:**
- Modify: `packages/cli/src/tmux-inject.ts`
- Test: `packages/cli/tests/tmux-inject.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/tmux-inject.test.ts`:

```ts
import { waitForReady } from "../src/tmux-inject.ts";

const noSleep = async () => {};
// Returns a capture fn that yields each scripted frame once, repeating the last.
const scripted = (frames: string[]): (() => Promise<string>) => {
  let i = 0;
  return async () => frames[Math.min(i++, frames.length - 1)]!;
};

test("waitForReady (glyph kind) returns 'ready' once the glyph appears in the tail", async () => {
  const cap = scripted(["booting...", "still booting", "│ ❯            │"]);
  const r = await waitForReady({
    glyph: "❯", capture: async () => cap(), sleep: noSleep,
    pollIntervalMs: 10, timeoutMs: 1000,
  });
  expect(r).toBe("ready");
});

test("waitForReady (glyph kind) returns 'timeout' when the glyph never appears", async () => {
  const r = await waitForReady({
    glyph: "❯", capture: async () => "no glyph here", sleep: noSleep,
    pollIntervalMs: 100, timeoutMs: 300, // → 3 attempts
  });
  expect(r).toBe("timeout");
});

test("waitForReady (null-glyph kind) returns 'ready' once capture is stable for 2 polls", async () => {
  // changing, changing, then identical twice → stable
  const cap = scripted(["a", "b", "c", "c"]);
  const r = await waitForReady({
    glyph: "", capture: async () => cap(), sleep: noSleep,
    pollIntervalMs: 10, timeoutMs: 1000,
  });
  expect(r).toBe("ready");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: FAIL — `waitForReady` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/cli/src/tmux-inject.ts`:

```ts
export const STABLE_POLLS = 2;

export interface WaitForReadyOpts {
  glyph: string;            // "" for null-glyph kinds → stability heuristic
  capture: TmuxCapture | (() => Promise<string>);
  sleep: Sleep;
  pollIntervalMs: number;
  timeoutMs: number;
}

// Poll until ready or the attempt budget (timeout/interval) is spent.
//  - glyph kinds: ready when the glyph renders in the tail (no stability check —
//    the glyph persists while the agent is busy, so presence = "box mounted")
//  - null-glyph kinds: ready when the capture is unchanged for STABLE_POLLS polls
export async function waitForReady(opts: WaitForReadyOpts): Promise<"ready" | "timeout"> {
  const attempts = Math.max(1, Math.ceil(opts.timeoutMs / opts.pollIntervalMs));
  let prev: string | null = null;
  let stableRun = 0;
  for (let n = 0; n < attempts; n++) {
    const cap = await (opts.capture as () => Promise<string>)();
    if (opts.glyph) {
      if (glyphInTail(cap, opts.glyph, PROMPT_SCAN_TAIL_LINES)) return "ready";
    } else {
      if (prev !== null && cap === prev) {
        if (++stableRun >= STABLE_POLLS - 1) return "ready";
      } else {
        stableRun = 0;
      }
      prev = cap;
    }
    if (n < attempts - 1) await opts.sleep(opts.pollIntervalMs);
  }
  return "timeout";
}
```

Note: `waitForReady` accepts `capture` typed as either `TmuxCapture` (pane → text) or a zero-arg closure; the orchestrator (Task 6) passes a closure that binds the pane, keeping this loop pane-agnostic.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: PASS (17 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tmux-inject.ts packages/cli/tests/tmux-inject.test.ts
git commit -m "cli: tmux-inject readiness polling loop"
```

---

### Task 5: Verified submit

Confirm the draft landed, settle, send Enter, and re-send until the draft clears or the verify budget is spent.

**Files:**
- Modify: `packages/cli/src/tmux-inject.ts`
- Test: `packages/cli/tests/tmux-inject.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/tmux-inject.test.ts`:

```ts
import { verifiedSubmit } from "../src/tmux-inject.ts";

const okExec = (sink: string[][]): TmuxExec => async (args) => { sink.push(args); return { code: 0, stdout: "" }; };

test("verifiedSubmit: draft seen then cleared after Enter → 'submitted'", async () => {
  const sent: string[][] = [];
  // capture: draft visible, then draft visible (commit poll), then cleared
  const cap = scripted(["│ ❯ hello there │", "│ ❯ hello there │", "│ ❯  │"]);
  const r = await verifiedSubmit({
    pane: "%3", glyph: "❯", needle: "hello there",
    exec: okExec(sent), capture: async () => cap(), sleep: noSleep,
    pollIntervalMs: 1, commitTimeoutMs: 50, verifyTimeoutMs: 50, retryIntervalMs: 5, settleMs: 0,
  });
  expect(r).toBe("submitted");
  expect(sent.some((a) => a[0] === "send-keys" && a.includes("Enter"))).toBe(true);
});

test("verifiedSubmit: draft never clears → re-sends Enter, returns 'submitted-unverified'", async () => {
  const sent: string[][] = [];
  const r = await verifiedSubmit({
    pane: "%3", glyph: "❯", needle: "stuck",
    exec: okExec(sent), capture: async () => "│ ❯ stuck │", sleep: noSleep,
    pollIntervalMs: 1, commitTimeoutMs: 10, verifyTimeoutMs: 30, retryIntervalMs: 1, settleMs: 0,
  });
  expect(r).toBe("submitted-unverified");
  const enters = sent.filter((a) => a[0] === "send-keys" && a.includes("Enter"));
  expect(enters.length).toBeGreaterThan(1); // initial + at least one re-send
});

test("verifiedSubmit: draft never seen → blind submit, no verify, 'submitted-unverified'", async () => {
  const sent: string[][] = [];
  const r = await verifiedSubmit({
    pane: "%3", glyph: "❯", needle: "absent",
    exec: okExec(sent), capture: async () => "│ ❯  │", sleep: noSleep,
    pollIntervalMs: 1, commitTimeoutMs: 10, verifyTimeoutMs: 30, retryIntervalMs: 1, settleMs: 0,
  });
  expect(r).toBe("submitted-unverified");
  const enters = sent.filter((a) => a[0] === "send-keys" && a.includes("Enter"));
  expect(enters.length).toBe(1); // blind submit only
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: FAIL — `verifiedSubmit` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/cli/src/tmux-inject.ts`:

```ts
export interface VerifiedSubmitOpts {
  pane: string;
  glyph: string;
  needle: string;
  exec: TmuxExec;
  capture: TmuxCapture | (() => Promise<string>);
  sleep: Sleep;
  pollIntervalMs: number;
  commitTimeoutMs: number;
  verifyTimeoutMs: number;
  retryIntervalMs: number;
  settleMs: number;
}

async function sendEnter(exec: TmuxExec, pane: string): Promise<void> {
  // No -l: tmux must interpret "Enter" as a key name, not literal text.
  await run(exec, ["send-keys", "-t", pane, "Enter"]);
}

export async function verifiedSubmit(o: VerifiedSubmitOpts): Promise<"submitted" | "submitted-unverified"> {
  const cap = o.capture as () => Promise<string>;

  // Phase 1: poll until the draft is visible in the input box.
  const commitAttempts = Math.max(1, Math.ceil(o.commitTimeoutMs / o.pollIntervalMs));
  let draftSeen = false;
  for (let n = 0; n < commitAttempts; n++) {
    if (draftLanded(await cap(), o.glyph, o.needle)) { draftSeen = true; break; }
    await o.sleep(o.pollIntervalMs);
  }

  await o.sleep(o.settleMs);
  await sendEnter(o.exec, o.pane);

  // Draft never observed → submit blind; nothing reliable to verify against.
  if (!draftSeen) return "submitted-unverified";

  // Phase 2: poll until the draft clears; re-send Enter every retryIntervalMs.
  const verifyAttempts = Math.max(1, Math.ceil(o.verifyTimeoutMs / o.pollIntervalMs));
  const retryEvery = Math.max(1, Math.round(o.retryIntervalMs / o.pollIntervalMs));
  for (let n = 0; n < verifyAttempts; n++) {
    await o.sleep(o.pollIntervalMs);
    if (!draftLanded(await cap(), o.glyph, o.needle)) return "submitted";
    if ((n + 1) % retryEvery === 0) await sendEnter(o.exec, o.pane);
  }
  return "submitted-unverified";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: PASS (20 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tmux-inject.ts packages/cli/tests/tmux-inject.test.ts
git commit -m "cli: tmux-inject verified submit"
```

---

### Task 6: `injectBootstrap` orchestrator + glyph map + report

Tie the primitives together: ready-gate → pre-clear → sanitize → paste → verified-submit, plus the per-kind glyph map and a one-line report formatter.

**Files:**
- Modify: `packages/cli/src/tmux-inject.ts`
- Test: `packages/cli/tests/tmux-inject.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/tmux-inject.test.ts`:

```ts
import { injectBootstrap, reportInject, READINESS_GLYPHS } from "../src/tmux-inject.ts";

test("READINESS_GLYPHS maps claude to the prompt glyph and others to null", () => {
  expect(READINESS_GLYPHS.claude).toBe("❯");
  expect(READINESS_GLYPHS.codex).toBeNull();
  expect(READINESS_GLYPHS.pi).toBeNull();
});

test("injectBootstrap (claude): ready → pre-clear → paste → submit, outcome 'submitted'", async () => {
  const sent: string[][] = [];
  const exec: TmuxExec = async (args) => { sent.push(args); return { code: 0, stdout: "" }; };
  // ready (glyph), then draft visible, then cleared
  const cap = scripted(["│ ❯  │", "│ ❯ do X │", "│ ❯  │"]);
  const res = await injectBootstrap({
    pane: "%3", text: "do X", agentKind: "claude",
    exec, capture: async () => cap(), sleep: noSleep,
  });
  expect(res.outcome).toBe("submitted");
  // pre-clear sends C-a and C-k before the paste
  expect(sent.some((a) => a.includes("C-a"))).toBe(true);
  expect(sent.some((a) => a.includes("C-k"))).toBe(true);
  expect(sent.some((a) => a[0] === "load-buffer")).toBe(true);
  expect(sent.some((a) => a[0] === "paste-buffer")).toBe(true);
});

test("injectBootstrap: readiness timeout still pastes+submits, outcome 'timeout-ready'", async () => {
  const exec: TmuxExec = async () => ({ code: 0, stdout: "" });
  const res = await injectBootstrap({
    pane: "%3", text: "hi", agentKind: "claude",
    exec, capture: async () => "never any glyph", sleep: noSleep,
    timeoutMs: 5, pollIntervalMs: 5, // 1 attempt → immediate timeout
  });
  expect(res.outcome).toBe("timeout-ready");
});

test("injectBootstrap: a failing tmux exec yields outcome 'failed', never throws", async () => {
  const exec: TmuxExec = async () => ({ code: 1, stdout: "" });
  const res = await injectBootstrap({
    pane: "%3", text: "hi", agentKind: "claude",
    exec, capture: async () => "│ ❯  │", sleep: noSleep,
  });
  expect(res.outcome).toBe("failed");
});

test("reportInject maps each outcome to a user-facing line", () => {
  expect(reportInject({ outcome: "submitted" })).toMatch(/prompt injected/);
  expect(reportInject({ outcome: "submitted-unverified" })).toMatch(/submit unconfirmed/);
  expect(reportInject({ outcome: "timeout-ready" })).toMatch(/timed out/);
  expect(reportInject({ outcome: "failed" })).toMatch(/failed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: FAIL — `injectBootstrap`/`reportInject`/`READINESS_GLYPHS` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/cli/src/tmux-inject.ts`:

```ts
// null = no known prompt glyph for this kind → readiness uses the stability
// heuristic + timeout. Confirm codex/pi glyphs against live TUIs before setting.
export const READINESS_GLYPHS: Record<AgentKind, string | null> = {
  claude: "❯",
  codex: null,
  pi: null,
};

export type InjectOutcome = "submitted" | "submitted-unverified" | "timeout-ready" | "failed";
export interface InjectResult { outcome: InjectOutcome; detail?: string; }

export interface InjectOpts {
  pane: string;
  text: string;
  agentKind?: AgentKind;
  timeoutMs?: number;
  pollIntervalMs?: number;
  exec?: TmuxExec;
  capture?: TmuxCapture;
  sleep?: Sleep;
}

const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 150;
const PASTE_SETTLE_MS = 100;
const PASTE_COMMIT_TIMEOUT_MS = 5_000;
const SUBMIT_VERIFY_TIMEOUT_MS = 10_000;
const SUBMIT_RETRY_INTERVAL_MS = 1_000;

export async function injectBootstrap(opts: InjectOpts): Promise<InjectResult> {
  const exec = opts.exec ?? defaultExec;
  const captureFn = opts.capture ?? defaultCapture;
  const sleep = opts.sleep ?? defaultSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const glyph = (opts.agentKind ? READINESS_GLYPHS[opts.agentKind] : null) ?? "";
  const capture = () => captureFn(opts.pane);

  try {
    const ready = await waitForReady({ glyph, capture, sleep, pollIntervalMs, timeoutMs });

    // Pre-clear any pre-populated text: C-a (Home) then C-k (kill-to-end).
    await run(exec, ["send-keys", "-t", opts.pane, "C-a"]);
    await run(exec, ["send-keys", "-t", opts.pane, "C-k"]);

    await pasteViaBuffer(opts.pane, sanitizePayload(opts.text), exec);

    const submit = await verifiedSubmit({
      pane: opts.pane, glyph, needle: computeNeedle(opts.text),
      exec, capture, sleep,
      pollIntervalMs,
      commitTimeoutMs: PASTE_COMMIT_TIMEOUT_MS,
      verifyTimeoutMs: SUBMIT_VERIFY_TIMEOUT_MS,
      retryIntervalMs: SUBMIT_RETRY_INTERVAL_MS,
      settleMs: PASTE_SETTLE_MS,
    });

    if (ready === "timeout") return { outcome: "timeout-ready" };
    return { outcome: submit };
  } catch (e) {
    return { outcome: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

export function reportInject(result: InjectResult): string {
  switch (result.outcome) {
    case "submitted": return "agmux: prompt injected";
    case "submitted-unverified": return "agmux: prompt injected (submit unconfirmed)";
    case "timeout-ready": return "agmux: prompt inject timed out — pane may still be booting";
    case "failed": return `agmux: prompt inject failed: ${result.detail ?? "unknown error"}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/tmux-inject.test.ts`
Expected: PASS (25 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tmux-inject.ts packages/cli/tests/tmux-inject.test.ts
git commit -m "cli: tmux-inject orchestrator + glyph map + report"
```

---

### Task 7: Parse `--prompt` / `--prompt-file`

Add the flags to `parse-run`, with mutual exclusion and the placement constraint. Keep `parse-run` pure (no file IO — `--prompt-file` stores the path; `bin/agmux.ts` reads it in Task 9).

**Files:**
- Modify: `packages/cli/src/parse-run.ts`
- Test: `packages/cli/tests/parse-run.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/parse-run.test.ts`:

```ts
test("--prompt requires a placement (inherit is rejected)", () => {
  const r = parseRunArgs(["--prompt", "do X", "-p", "work"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/--prompt requires --new-pane/);
});

test("--prompt with --new-window carries the prompt text", () => {
  const r = parseRunArgs(["--new-window", "--prompt", "do X", "-p", "work"]);
  expect(r).toMatchObject({ kind: "profile", profileName: "work", placement: "new-window", prompt: "do X" });
});

test("--prompt composes with -d (inline)", () => {
  const r = parseRunArgs(["-d", "--prompt", "hello", "claude"]);
  expect(r).toMatchObject({ kind: "inline", agent_kind: "claude", placement: "new-pane", prompt: "hello" });
});

test("--prompt-file stores the path, not the contents", () => {
  const r = parseRunArgs(["--new-pane", "--prompt-file", "/tmp/p.txt", "claude"]);
  expect(r).toMatchObject({ kind: "inline", placement: "new-pane", promptFile: "/tmp/p.txt" });
});

test("--prompt and --prompt-file are mutually exclusive", () => {
  const r = parseRunArgs(["--new-pane", "--prompt", "x", "--prompt-file", "/tmp/p.txt", "claude"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine --prompt with --prompt-file/);
});

test("--prompt requires a value", () => {
  const r = parseRunArgs(["--new-pane", "--prompt"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/--prompt requires a value/);
});

test("no prompt flag → prompt/promptFile absent", () => {
  const r = parseRunArgs(["claude"]);
  expect(r).toMatchObject({ kind: "inline" });
  if (r.kind === "inline") { expect(r.prompt).toBeUndefined(); expect(r.promptFile).toBeUndefined(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/parse-run.test.ts`
Expected: FAIL — prompt flags unrecognized; new assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/parse-run.ts`:

1. Add `prompt?` / `promptFile?` to both non-error variants of `ParsedRun`:

```ts
export type ParsedRun =
  | { kind: "profile"; profileName: string; placement: Placement; detach: boolean; wrapped: boolean; prompt?: string; promptFile?: string }
  | { kind: "inline"; agent_kind: "claude" | "codex" | "pi"; command: string; args: string[]; placement: Placement; detach: boolean; wrapped: boolean; prompt?: string; promptFile?: string }
  | { kind: "error"; message: string };
```

2. Declare locals near the other flag vars (after `let wrapped = false;`):

```ts
  let prompt: string | undefined;
  let promptFile: string | undefined;
```

3. Add two flag branches inside the `while` loop, before the final `break;` (alongside `--wrapped`):

```ts
    if (a === "--prompt") {
      const v = argv[i + 1];
      if (v === undefined) return { kind: "error", message: `--prompt requires a value` };
      prompt = v;
      i += 2;
      continue;
    }
    if (a === "--prompt-file") {
      const v = argv[i + 1];
      if (v === undefined) return { kind: "error", message: `--prompt-file requires a value` };
      promptFile = v;
      i += 2;
      continue;
    }
```

4. After the loop, before the `if (profileName)` block, validate:

```ts
  if (prompt !== undefined && promptFile !== undefined) {
    return { kind: "error", message: "cannot combine --prompt with --prompt-file" };
  }
  if ((prompt !== undefined || promptFile !== undefined) && placement === "inherit") {
    return { kind: "error", message: "--prompt requires --new-pane, --new-window, or --new-session" };
  }
```

5. Thread `prompt`/`promptFile` into both successful returns. Profile return:

```ts
    return { kind: "profile", profileName, placement, detach, wrapped, prompt, promptFile };
```

Inline return (last line of the function):

```ts
  return { kind: "inline", agent_kind, command, args, placement, detach, wrapped, prompt, promptFile };
```

Note: existing `.toEqual` tests omit `prompt`/`promptFile`; bun's `toEqual` ignores `undefined`-valued properties, so they keep passing unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/parse-run.test.ts`
Expected: PASS (all prior tests + 7 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parse-run.ts packages/cli/tests/parse-run.test.ts
git commit -m "cli: parse --prompt/--prompt-file for run"
```

---

### Task 8: Wire injection into `runWithPlacement`

Thread `prompt` + `agentKind` through `RunOpts`, and add a `runInjectStep` helper that runs the inject and returns the report (never throwing), called after the pane is placed.

**Files:**
- Modify: `packages/cli/src/run.ts`
- Test: `packages/cli/tests/run.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/run.test.ts`:

```ts
import { runInjectStep } from "../src/run.ts";

test("runInjectStep returns null when no prompt is set", async () => {
  let called = false;
  const r = await runInjectStep(
    { pane: "%3", prompt: undefined, agentKind: "claude" },
    async () => { called = true; return { outcome: "submitted" as const }; },
  );
  expect(r).toBeNull();
  expect(called).toBe(false);
});

test("runInjectStep invokes the injector with the pane and returns a report line", async () => {
  let seenPane = "";
  const r = await runInjectStep(
    { pane: "%7", prompt: "do X", agentKind: "claude" },
    async (o) => { seenPane = o.pane; return { outcome: "submitted" as const }; },
  );
  expect(seenPane).toBe("%7");
  expect(r).toMatch(/prompt injected/);
});

test("runInjectStep never throws even if the injector rejects", async () => {
  const r = await runInjectStep(
    { pane: "%9", prompt: "boom", agentKind: "claude" },
    async () => { throw new Error("kaboom"); },
  );
  expect(r).toMatch(/failed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/run.test.ts`
Expected: FAIL — `runInjectStep` not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/run.ts`:

1. Extend the imports at the top:

```ts
import type { AgentKind } from "@agmux/protocol";
import { injectBootstrap, reportInject, type InjectOpts, type InjectResult } from "./tmux-inject.ts";
```

2. Add `agentKind?` and `prompt?` to the shared `RunOpts` inputs. On both `RunProfileOpts` and `RunInlineOpts` interfaces add:

```ts
  agentKind?: AgentKind;   // resolved kind for readiness glyph (may be undefined)
  prompt?: string;         // bootstrap prompt to inject after placement
```

3. Add the injectable helper (place it above `runWithPlacement`):

```ts
export type Injector = (opts: InjectOpts) => Promise<InjectResult>;

// Run the bootstrap inject against a just-placed pane. Returns a report line to
// print, or null when there is nothing to inject. NEVER throws — a failed inject
// must not change the spawn's exit code (the session is already recorded).
export async function runInjectStep(
  args: { pane: string; prompt?: string; agentKind?: AgentKind },
  inject: Injector = injectBootstrap,
): Promise<string | null> {
  if (!args.prompt) return null;
  try {
    const result = await inject({ pane: args.pane, text: args.prompt, agentKind: args.agentKind });
    return reportInject(result);
  } catch (e) {
    return reportInject({ outcome: "failed", detail: e instanceof Error ? e.message : String(e) });
  }
}
```

4. In `runWithPlacement`, after the existing `console.log(`agmux: spawned in ...`)` line, inject:

```ts
  const report = await runInjectStep({ pane: coords.pane, prompt: opts.prompt, agentKind: opts.agentKind });
  if (report) console.log(report);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/run.test.ts`
Expected: PASS (existing 2 + 3 new).

- [ ] **Step 5: Run the full cli suite to confirm nothing regressed**

Run: `bun test packages/cli/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/run.ts packages/cli/tests/run.test.ts
git commit -m "cli: inject bootstrap prompt after run placement"
```

---

### Task 9: CLI entry wiring + usage

Resolve `--prompt-file` to text in `bin/agmux.ts`, pass `prompt`/`agentKind` into `runCmd`, and document the flags. This is the integration seam; correctness is covered by Tasks 7–8 plus the manual smoke test.

**Files:**
- Modify: `packages/cli/bin/agmux.ts`

- [ ] **Step 1: Resolve the prompt and pass it through**

In `packages/cli/bin/agmux.ts`, inside `case "run":`, after `parsed` is validated and `kind` is resolved (the block that computes `kind`/`profileEnv`/`mode`), and before the two `return runCmd(...)` calls, add the prompt resolution:

```ts
      // Resolve --prompt-file to text (parse-run kept the path; IO lives here).
      let prompt: string | undefined = parsed.prompt;
      if (parsed.promptFile) {
        try { prompt = await Bun.file(parsed.promptFile).text(); }
        catch (e) { console.error(`agmux run: cannot read --prompt-file ${parsed.promptFile}: ${e instanceof Error ? e.message : String(e)}`); return 2; }
      }
```

Then add `agentKind: kind, prompt` to both `runCmd({...})` option objects. Profile call:

```ts
        return runCmd({
          kind: "profile", profileName: parsed.profileName,
          placement: parsed.placement, detach: parsed.detach, hubUrl, wrapBin, mode,
          agentKind: kind, prompt,
        }, agmuxBin);
```

Inline call:

```ts
      return runCmd({
        kind: "inline", agent_kind: parsed.agent_kind, command: parsed.command, args: parsed.args,
        placement: parsed.placement, detach: parsed.detach, hubUrl, wrapBin, mode,
        agentKind: kind, prompt,
      }, agmuxBin);
```

- [ ] **Step 2: Update the usage text**

In the `usage()` template literal, change the `run` line to document the flag:

```
  run [placement] [--wrapped] [--kind=<claude|codex|pi>] [--prompt <text>|--prompt-file <path>] <command> [args...]
  run [placement] [--wrapped] [--prompt <text>|--prompt-file <path>] -p <profile>
    --prompt <text>   inject a bootstrap prompt after spawn (requires --new-pane/--new-window/--new-session)
```

- [ ] **Step 3: Typecheck and run the full suite**

Run: `bun test packages/cli/` and (if the repo has it) `bun run typecheck` or `bunx tsc --noEmit -p packages/cli`.
Expected: PASS / no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/bin/agmux.ts
git commit -m "cli: wire --prompt/--prompt-file into run entrypoint"
```

---

### Task 10: Manual smoke test & module design note

The unit suite never touches a live tmux (repo convention). Validate the real mechanics by hand and capture a gotcha note.

**Files:**
- Modify: `packages/cli/src/tmux-inject.ts` (top-of-file note only, if anything is learned)

- [ ] **Step 1: Smoke matrix against a live claude pane**

From inside a tmux session, with a built `agmux` on PATH, run each and confirm the prompt submits exactly once:

```bash
# short prompt
agmux run --new-window -p <claude-profile> --prompt "say hello in one word"
# multi-line prompt
printf 'line one\nline two\nline three\n' > /tmp/p.txt
agmux run --new-window -p <claude-profile> --prompt-file /tmp/p.txt
# >16 KB prompt (exercises the load-buffer path, not argv)
yes "padding line" | head -c 20000 > /tmp/big.txt
agmux run --new-window -p <claude-profile> --prompt-file /tmp/big.txt
# trailing backslash (must not become a line-continuation)
agmux run --new-window -p <claude-profile> --prompt 'ends with a backslash \'
# rapid sequential injects into the same session
for i in 1 2 3; do agmux run --new-window -p <claude-profile> --prompt "ping $i"; done
```

For each: confirm the message appears as a single submitted prompt (not split per line, not left unsent, not duplicated). Note the printed report line.

- [ ] **Step 2: Record findings**

If any case needed a tweaked constant or revealed a gotcha (e.g. a codex/pi readiness glyph), update the relevant constant in `tmux-inject.ts` and add a one-line comment. If a `codex`/`pi` glyph is confirmed, set it in `READINESS_GLYPHS` and add a glyph-kind test for it in Task 2's style.

- [ ] **Step 3: Commit any changes**

```bash
git add -A && git commit -m "cli: tmux-inject smoke-test findings"
```

(If nothing changed, skip the commit.)

---

## Self-Review

**Spec coverage:**
- §3 send-keys hazards → sanitizePayload (Task 1), buffer paste (Task 3), verified submit (Task 5). ✓
- §4 module shape, exec seams, no `-S` → Task 3. ✓
- §5.1 readiness (tail-5 glyph; null-glyph stability; timeout) → Tasks 2, 4, 6. ✓
- §5.2 pre-clear → Task 6. ✓
- §5.3 sanitization → Task 1. ✓
- §5.4 buffer paste flags → Task 3. ✓
- §5.5 verified submit (needle, placeholder, settle, blind, re-send) → Tasks 1, 2, 5. ✓
- §6 `--prompt`/`--prompt-file`, placement constraint, reporting, exit code → Tasks 7, 8, 9. ✓
- §7 no event emitted → no event code added anywhere (verified by omission). ✓
- §8 testing incl. manual matrix → Tasks 1–9 unit, Task 10 manual. ✓
- §9 file plan → matches Tasks. ✓
- §10 future seams (codex/pi glyph, structured channel, delegate, steering) → left out by design; codex/pi glyph revisit in Task 10. ✓

**Placeholder scan:** No TBD/TODO in steps; every code step shows complete code. The `codex`/`pi` `null` glyphs are an intentional documented value, not a placeholder.

**Type consistency:** `TmuxExec(args, stdin?) → {code, stdout}` used identically in Tasks 3, 5, 6. `InjectResult`/`InjectOutcome`/`InjectOpts` consistent across Tasks 6, 8. `runInjectStep(args, inject)` signature matches between Task 8 impl and test. `READINESS_GLYPHS` keyed by `AgentKind` (claude/codex/pi) matches `protocol`. `prompt?`/`promptFile?` names consistent across Tasks 7, 8, 9.

---

## Execution Handoff

Plan complete. Recommended: subagent-driven execution (fresh subagent per task, review between tasks). Tasks 1–6 are pure/independent of the CLI surface; Tasks 7–9 are sequential (parse → run → bin); Task 10 is manual and requires a live tmux + a configured claude profile.
