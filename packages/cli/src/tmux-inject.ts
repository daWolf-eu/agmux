// Bootstrap prompt injection into a freshly-spawned agent's tmux pane.
// Ported from omnigent's claude_native_bridge.py (inject_user_message + helpers).
// Scope: spawn/bootstrap only (foundation §8/§14.9) — never a steering loop.
//
// All tmux access flows through injected exec/capture/sleep seams so the logic
// unit-tests with no live tmux, mirroring tmux-place.ts / dash-preview.ts.

// AgentKind keys the per-kind readiness glyph map added in a later task.
import type { AgentKind } from "@agmux/protocol";

export const DRAFT_NEEDLE_MAX_CHARS = 24;

const enc = new TextEncoder();

// Build the exact bytes to load into a tmux buffer for a bracketed paste.
//  - normalize CRLF/CR → \n, then append a trailing \n so a trailing "\" can't
//    escape the submit Enter (line-continuation bug)
//  - \n → 0x0D (CR): under bracketed paste the TUI keeps these as in-draft newlines
//  - \t → 0x09 (kept)
//  - any other byte < 0x20 dropped: a stray ESC would prematurely close the paste
//  - everything else → UTF-8 bytes (incl. DEL 0x7F, passed through for parity
//    with omnigent, which only drops < 0x20)
export function sanitizePayload(text: string): Uint8Array {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + "\n";
  const out: number[] = [];
  for (const ch of normalized) {
    if (ch === "\n") { out.push(0x0d); continue; }
    if (ch === "\t") { out.push(0x09); continue; }
    const code = ch.codePointAt(0)!;
    if (code < 0x20) continue;
    for (const b of enc.encode(ch)) out.push(b);
  }
  return Uint8Array.from(out);
}

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
  // Scope to the same tail window as glyphInTail so the predicate is correct
  // even if called without a prior readiness gate (a stale scrollback glyph
  // above the tail must not produce a spurious match). The bottom-most glyph
  // line in the tail is the live input box.
  const glyphLines = tailNonEmptyLines(capture, PROMPT_SCAN_TAIL_LINES).filter((l) => l.includes(glyph));
  if (glyphLines.length === 0) return false;
  const after = glyphLines[glyphLines.length - 1]!.split(glyph).pop() ?? "";
  if (after.includes(PASTED_PLACEHOLDER)) return true;
  return needle.length > 0 && after.includes(needle);
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

export const STABLE_POLLS = 2;

export interface WaitForReadyOpts {
  glyph: string;            // "" for null-glyph kinds → stability heuristic
  capture: () => Promise<string>;   // pane already bound by the orchestrator
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
    const cap = await opts.capture();
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

export interface VerifiedSubmitOpts {
  pane: string;
  glyph: string;
  needle: string;
  exec: TmuxExec;
  capture: () => Promise<string>;   // pane already bound by the orchestrator
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
  const cap = o.capture;

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

// Deliver text into the pane's input box via a tmux buffer (NOT send-keys):
//  - load-buffer dodges the ~16 KB argv cap (bytes arrive on stdin)
//  - paste-buffer -p uses bracketed paste so multi-line lands as one chunk
//    (dodges the per-newline submit bug, anthropics/claude-code#52126)
//  - -d deletes the named buffer afterward
export async function pasteViaBuffer(pane: string, bytes: Uint8Array, exec: TmuxExec): Promise<void> {
  await run(exec, ["load-buffer", "-b", PASTE_BUFFER_NAME, "-"], bytes);
  await run(exec, ["paste-buffer", "-t", pane, "-b", PASTE_BUFFER_NAME, "-p", "-d"]);
}

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

    // Readiness timed out AND we couldn't confirm the submit → the louder signal
    // is "pane may still be booting". If the submit was confirmed despite the
    // timeout, report that success rather than masking it (spec §5.5).
    if (ready === "timeout" && submit === "submitted-unverified") return { outcome: "timeout-ready" };
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
