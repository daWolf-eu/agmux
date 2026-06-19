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
