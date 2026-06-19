import { test, expect } from "bun:test";
import {
  sanitizePayload, computeNeedle, glyphInTail, draftLanded, PROMPT_SCAN_TAIL_LINES,
  pasteViaBuffer, waitForReady, verifiedSubmit, type TmuxExec,
  injectBootstrap, reportInject, READINESS_GLYPHS,
} from "../src/tmux-inject.ts";

const noSleep = async () => {};
// Returns a capture fn that yields each scripted frame once, repeating the last.
const scripted = (frames: string[]): (() => Promise<string>) => {
  let i = 0;
  return async () => frames[Math.min(i++, frames.length - 1)]!;
};

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

test("sanitizePayload of empty string is just the appended trailing CR", () => {
  expect(bytes("")).toEqual([0x0d]);
});

test("computeNeedle of empty string is empty", () => {
  expect(computeNeedle("")).toBe("");
});

test("computeNeedle takes the first non-empty line, stripped, truncated at first control char, max 24 chars", () => {
  expect(computeNeedle("  hello world  ")).toBe("hello world");
  expect(computeNeedle("\n\n  second line is used")).toBe("second line is used");
  expect(computeNeedle("before\tafter")).toBe("before"); // truncates at the tab
  expect(computeNeedle("x".repeat(40))).toBe("x".repeat(24));
  expect(computeNeedle("   \n   ")).toBe(""); // all whitespace → empty needle
});

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
