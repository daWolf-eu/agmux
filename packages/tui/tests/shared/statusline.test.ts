import { test, expect } from "bun:test";
import { formatStatusLine, abbreviate, type StatusLineOpts } from "../../src/shared/statusline.ts";
import { mkRow } from "../helpers/mk-row.ts";

const OPTS: StatusLineOpts = { show: "all", max: 6, format: "{glyph} {tmux_session}:{tmux_window}" };

test("renders one entry with glyph colour and tmux coords", () => {
  const rows = [mkRow({ session_id: "agx-1", status: "running", tmux_session: "work", tmux_window: "2" })];
  expect(formatStatusLine(rows, OPTS)).toBe("#[range=user|agx-1]#[fg=#a6e3a1]○ work:2#[default]#[norange]");
});

test("separates multiple entries with two spaces", () => {
  const rows = [
    mkRow({ session_id: "a", status: "running", tmux_session: "w", tmux_window: "1" }),
    mkRow({ session_id: "b", status: "waiting", tmux_session: "w", tmux_window: "2" }),
  ];
  const out = formatStatusLine(rows, OPTS);
  expect(out).toContain("#[fg=#a6e3a1]○ w:1#[default]#[norange]  #[range=user|b]");
});

test("null fields collapse the separator rather than leaving a dangling colon", () => {
  const rows = [mkRow({ session_id: "a", status: "idle", tmux_session: "w", tmux_window: null })];
  expect(formatStatusLine(rows, OPTS)).toContain("○ w");
  expect(formatStatusLine(rows, OPTS)).not.toContain("w:");
});

test("{glyph} carries read-ness in its shape and status in its colour", () => {
  const base = { session_id: "a", status: "waiting" as const, tmux_session: "w", tmux_window: "1" };
  const unread = formatStatusLine([mkRow({ ...base, unread: true })], OPTS);
  const read = formatStatusLine([mkRow({ ...base, unread: false })], OPTS);
  expect(unread).toContain("#[fg=#f9e2af]● w:1");
  expect(read).toContain("#[fg=#f9e2af]○ w:1");
});

test("show=waiting keeps only waiting rows", () => {
  const rows = [mkRow({ session_id: "a", status: "running" }), mkRow({ session_id: "b", status: "waiting" })];
  expect(formatStatusLine(rows, { ...OPTS, show: "waiting" })).toContain("range=user|b");
  expect(formatStatusLine(rows, { ...OPTS, show: "waiting" })).not.toContain("range=user|a");
});

test("show=unread keeps only unread rows", () => {
  const rows = [mkRow({ session_id: "a", unread: false }), mkRow({ session_id: "b", unread: true })];
  expect(formatStatusLine(rows, { ...OPTS, show: "unread" })).not.toContain("range=user|a");
  expect(formatStatusLine(rows, { ...OPTS, show: "unread" })).toContain("range=user|b");
});

test("overflow past max collapses to a +N chip", () => {
  const rows = Array.from({ length: 5 }, (_, i) => mkRow({ session_id: `s${i}`, tmux_session: "w", tmux_window: String(i) }));
  expect(formatStatusLine(rows, { ...OPTS, max: 3 })).toContain("+2");
});

test("empty row list renders an empty string, not a stray separator", () => {
  expect(formatStatusLine([], OPTS)).toBe("");
});

test("abbreviate truncates from the middle, keeping the suffix legible", () => {
  expect(abbreviate("very-long-session-name-7", 12)).toBe("very-l…ame-7");
  expect(abbreviate("short", 12)).toBe("short");
});

test("never exceeds the width budget at any max", () => {
  const s = "very-long-session-name-7";
  for (let m = 1; m <= 20; m++) {
    const result = abbreviate(s, m);
    expect([...result].length).toBeLessThanOrEqual(m);
  }
});

test("preserves data with trailing separators in renderFormat", () => {
  const rows = [mkRow({ session_id: "a", project: "foo/", tmux_session: "work", tmux_window: null })];
  const out1 = formatStatusLine(rows, { ...OPTS, format: "{agent_kind} {project}" });
  expect(out1).toContain("foo/");
  expect(out1).not.toContain("foo/ ");

  const out2 = formatStatusLine(rows, { ...OPTS, format: "{glyph} {tmux_session}:{tmux_window}" });
  expect(out2).toContain("○ work");
  expect(out2).not.toContain("work:");
});

test("format string honours other placeholders", () => {
  const rows = [mkRow({ session_id: "agx-abcdef123", status: "running", agent_kind: "codex", project: "agmux" })];
  const out = formatStatusLine(rows, { ...OPTS, format: "{agent_kind}/{project} {status}" });
  expect(out).toContain("codex/agmux running");
});
